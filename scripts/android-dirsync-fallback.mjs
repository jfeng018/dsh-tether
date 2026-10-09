// Android 上 App 不能 open 自己沙箱外的目录:`/data/user/0` 是 `drwxrwx--x system system`,
// 普通 App 落在 other 位上,只有 x 没有 r,而 fsync 一个目录要先 `open(O_RDONLY)` —— 恒 EACCES。
//
// attachment-local 入库附件时,会把目标目录的每一级祖先逐个 fsync 到一个「调用方保证已持久」
// 的边界为止,而 ensureDurableHome 传的边界是**文件系统根**(`parse(home).root`)。于是这个
// walk 一定会走出 App 沙箱,在 `/data/user/0` 上 EACCES —— 手机本地模式下发一张图必失败,
// 界面报 `prompt rejected`,详情是 `EACCES: permission denied, open '/data/user/0'`。
//
// 打 tar 时把目录 fsync 换成「EACCES/EPERM 就跳过这一级」。跳过不损失 durability:App 能
// 创建的目录都在沙箱内,它们的父目录也在沙箱内、照旧被 fsync;再往上全是系统目录,本进程
// 从未改动过它们的目录项,没有需要落盘的东西。
//
// 2026-10-09 在 Redmi 23113RKC6C(Android 16)上实测:file input 与粘贴两条附件路径都是
// 这个错。同一台机器上会话 jsonl 落盘一直是好的 —— session-persistence 只 fsync 自己那
// 两三层目录,从不往上 walk,这也是为什么只验发消息的话,这处问题一次都不会露头。
//
// storage-json 的 fsyncDirectory 也是目录 fsync,但它只 fsync 一层、调用点都在 DSH_HOME 里,
// 实测正常,所以不动它 —— 它在残留扫描的白名单上。
import { readFileSync, writeFileSync } from 'node:fs'
import { findCopies, dshLibDirs, walkJs } from './android-link-fallback.mjs'

const HELPER = '__tetherSyncDir'

// 逐字匹配 syncDirectory 的函数体。换 dsh 版本后对不上就让构建失败,照新代码改这张表。
const FIND = [
  '\tconst handle = await open(path, constants.O_RDONLY);',
  '\ttry {',
  '\t\tawait handle.sync();',
  '\t} finally {',
  '\t\tawait handle.close();',
  '\t}',
].join('\n')

export const SITES = [
  {
    file: '@deepseek-ai/dsh-attachment-local/lib/index.js',
    find: FIND,
    into: `\tawait ${HELPER}(path, constants.O_RDONLY);`,
  },
]

// 注入到模块开头。用模块自己 import 进来的 open(函数声明会提升,调用时它已绑定),
// 这样不必再注入 node:fs/promises —— 同一个文件上 android-link-fallback 已经注入过一份。
// 写法照上游文件(tab、分号、双引号)
const PRELUDE = `/** dsh-tether: an app cannot open directories outside its sandbox; see scripts/android-dirsync-fallback.mjs */
async function ${HELPER}(path, flags) {
	let handle;
	try {
		handle = await open(path, flags);
	} catch (error) {
		if (["EACCES", "EPERM"].includes(error?.code)) return;
		throw error;
	}
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}
`

// 目录 fsync 的实现点 = 只读 open 紧跟 handle.sync()。只读 open 而不 fsync 的是在读文件,
// 与此无关(fs-local 读文件、readFirstLine、exists 探测都是那种,数量可观)。
// flags 必须是字面量:补丁后 helper 自己那处是 `open(path, flags)`,变量传参,不在此列;
// openSync( 也不匹配(open 后面不是左括号)
const DIR_OPEN = /\bopen\(\s*[\w$.]+\s*,\s*(?:constants\.O_RDONLY|["']r["'])\s*\)/

// 目录 fsync 本身没问题 —— 只有「以文件系统根为边界、逐级往上 walk」的那种会走出 App 沙箱。
// 下面这些的调用方传的都是显式单层路径,最高到 DSH_HOME 本身,仍在沙箱内:
//   session-persistence  syncDirectory   dirname(currentPath),会话目录(会话格式迁移时发布新代)
//   session-persistence  syncDirPosix    dirname(this.root) / this.root / project,最高到 DSH_HOME
//   storage-json         fsyncDirectory  dirname(<storages 下的那个文件>)
// 处数写死:新增一处就让构建失败,好让人去判断它的调用方会不会走出沙箱。
const ALLOWED = {
  'dsh-session-persistence-jsonl/lib/index.js': 2,
  'dsh-session-persistence-jsonl/lib/worker.cjs': 1,
  'dsh-storage-json/lib/index.js': 1,
}

/** 打补丁并确认 @deepseek-ai 各包 lib 里没有未经判断的目录 fsync */
export function patchDirSync(nodeModules) {
  for (const { file, find, into } of SITES) {
    const copies = findCopies(nodeModules, file)
    if (copies.length === 0) throw new Error(`${file}: 树里找不到,npm 布局或 dsh 版本变了`)
    for (const path of copies) {
      const src = readFileSync(path, 'utf8')
      const hits = src.split(find).length - 1
      if (hits !== 1) throw new Error(`${path}: 期望恰好一处目录 fsync,实际 ${hits} 处(dsh 版本变了?)`)
      writeFileSync(path, PRELUDE + src.replace(find, into))
    }
  }
  const left = []
  for (const lib of dshLibDirs(nodeModules)) walkJs(lib, (p) => {
    const lines = readFileSync(p, 'utf8').split('\n')
    const hits = []
    lines.forEach((line, i) => {
      // 只读 open 之后紧跟着 fsync 才算目录 fsync;隔着函数体的 sync() 不算,所以只看后几行
      if (DIR_OPEN.test(line) && /\.sync\(\)/.test(lines.slice(i, i + 6).join('\n'))) {
        hits.push(`${p}:${i + 1}: ${line.trim()}`)
      }
    })
    if (hits.length === 0) return
    const known = Object.keys(ALLOWED).find((a) => p.replace(/\\/g, '/').endsWith(a))
    if (known === undefined) left.push(...hits)
    else if (hits.length !== ALLOWED[known]) {
      left.push(`${p}: 目录 fsync 期望 ${ALLOWED[known]} 处,实得 ${hits.length} 处(dsh 版本变了?)`)
    }
  })
  if (left.length) throw new Error(`有未经判断的目录 fsync,调用方若 walk 出 App 沙箱就会 EACCES:\n${left.join('\n')}`)
}
