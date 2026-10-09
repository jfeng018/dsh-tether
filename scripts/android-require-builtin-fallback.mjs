// node-addon-require-builtin 没有 android 构建:这个包只发了 linux/darwin/win 的预编译件,
// require 它一定抛 "No usable native binding found for node-addon-require-builtin-android-arm64"。
//
// dsh 0.2 起 @deepseek-ai/dsh-app-boot 要用 Node 的内部模块加载器做 profile 解析拦截,取内部
// 模块的写法直奔这个原生件,没有回退:
//     const addon = createRequire(import.meta.url)("node-addon-require-builtin");
// 于是 0.2 的运行时在手机上开机即 fatal:`dsh: host preparation failed: No usable native
// binding found for ...`,界面停在「本机 DSH 启动失败」。0.1.5 的 app-boot 里没有这段,所以
// 这是 0.2 新引入的;上游到 0.2.1-alpha.2 仍是这个写法。
//
// 同一件事 @deepseek-ai/cordis-plugin-loader 自己是带回退的(lib/index.js:先看 execArgv 里有
// --expose-internals 就直接 require("internal/..."),拿不到才退到原生件),App 在 0.1.5 上能起
// 来正是靠它 —— local.rs 给 node 传了 --expose-internals。这个补丁把 app-boot 改成同样的次序。
//
// 2026-10-09 在 Redmi 23113RKC6C(Android 16)上实测 Node 24.18.0:--expose-internals 下那五个
// 内部模块都 require 得到,app-boot 随后做的六项形态检查(resolveSync、getOrCreateModuleJob、
// Module._resolveFilename、getCjsConditions、getDefaultConditions、defaultResolve)全是
// function;worker 线程继承 execArgv,里面同样 require 得到 —— 两处站点有一处就在 worker 里。
import { readFileSync, writeFileSync } from 'node:fs'
import { findCopies, dshLibDirs, walkJs } from './android-link-fallback.mjs'

const HELPER = '__tetherRequireBuiltin'

// 逐字匹配取内部模块那一行。换 dsh 版本后对不上就让构建失败,照新代码改这张表。
const FIND = '\tconst addon = createRequire(import.meta.url)("node-addon-require-builtin");'
const INTO = `\tconst addon = ${HELPER}();`

export const SITES = [
  { file: '@deepseek-ai/dsh-app-boot/lib/index.js', find: FIND, into: INTO },
  // 同一份解析拦截又打进了跑在 worker 线程里的那份
  { file: '@deepseek-ai/dsh-app-boot/lib/worker/profile-resolution-bootstrap.js', find: FIND, into: INTO },
]

// 注入到模块开头。用模块自己 import 进来的 createRequire(import 声明会提升,调用时它已绑定)。
// 写法照上游文件(tab、分号、双引号)
const PRELUDE = `/** dsh-tether: node-addon-require-builtin has no android build; see scripts/android-require-builtin-fallback.mjs */
function ${HELPER}() {
	const nodeRequire = createRequire(import.meta.url);
	if (process.execArgv.includes("--expose-internals")) try {
		nodeRequire("internal/modules/esm/loader");
		return { requireBuiltin: (id) => nodeRequire(id) };
	} catch {}
	return nodeRequire("node-addon-require-builtin");
}
`

const REQUIRE_ADDON = /["']node-addon-require-builtin["']/

// 这个原生件在 Android 上一定拿不到,所以引用它的地方必须都带回退。下面这处上游自带回退,
// 处数写死:新增一处就让构建失败,好让人去判断它有没有回退。
const ALLOWED = { '@deepseek-ai/cordis-plugin-loader/lib/index.js': 1 }

/** 打补丁并确认 @deepseek-ai 各包 lib 里没有不带回退的 node-addon-require-builtin 引用 */
export function patchRequireBuiltin(nodeModules) {
  for (const { file, find, into } of SITES) {
    const copies = findCopies(nodeModules, file)
    if (copies.length === 0) throw new Error(`${file}: 树里找不到,npm 布局或 dsh 版本变了`)
    for (const path of copies) {
      const src = readFileSync(path, 'utf8')
      const hits = src.split(find).length - 1
      if (hits !== 1) throw new Error(`${path}: 期望恰好一处取内部模块,实际 ${hits} 处(dsh 版本变了?)`)
      writeFileSync(path, PRELUDE + src.replace(find, into))
    }
  }
  const left = []
  for (const lib of dshLibDirs(nodeModules)) walkJs(lib, (p) => {
    // 注入的 helper 里那一处引用是本意(回退就在它自己身上),跳过前导段再扫
    const text = readFileSync(p, 'utf8')
    const skip = text.startsWith(PRELUDE) ? PRELUDE.split('\n').length - 1 : 0
    const hits = []
    text.split('\n').slice(skip).forEach((line, i) => {
      if (REQUIRE_ADDON.test(line)) hits.push(`${p}:${skip + i + 1}: ${line.trim()}`)
    })
    if (hits.length === 0) return
    const known = Object.keys(ALLOWED).find((a) => p.replace(/\\/g, '/').endsWith(a))
    if (known === undefined) left.push(...hits)
    else if (hits.length !== ALLOWED[known]) {
      left.push(`${p}: 期望 ${ALLOWED[known]} 处引用,实得 ${hits.length} 处(dsh 版本变了?)`)
    }
  })
  if (left.length) throw new Error(`有不带回退的 node-addon-require-builtin 引用,Android 上没有它的原生件:\n${left.join('\n')}`)
}
