import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const loader = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false, watch: null }, optimizeDeps: { noDiscovery: true }, appType: 'custom' });
let PROGRAM_TOOL_REGISTRY, PROGRAM_API;
try { ({ PROGRAM_TOOL_REGISTRY, PROGRAM_API } = await loader.ssrLoadModule('/src/chrome/tool.ts')); }
finally { await loader.close(); }

const path = fileURLToPath(new URL('../docs/tools.md', import.meta.url));
const escape = text => text.replaceAll('|', '\\|').replaceAll('\n', ' ');
const table = registry => registry.map(tool => `| \`${tool.name}\` | ${escape(tool.description)} |`).join('\n');
const content = `# Surf Wax 工具参考\n\n此文件由真实工具 registry 自动生成（npm run docs:tools）。所有新回合公开 ${PROGRAM_TOOL_REGISTRY.length} 个入口：inspect 了解页面、run 组合执行、jobs 管理长执行。旧会话的 canonical 历史原样保留；继续、重试、自定义提示词及压缩后的回合统一使用这三个工具，旧工具名称不再可执行。\n\ninspect 默认只返回语义文本，有视觉能力的模型也不会自动截图；图片、布局、Canvas 或歧义才显式请求 image=true。文本支持区域、字段、字符预算、分页、截断说明与 since 增量；增量只返回 changes，不重复全页。ref 带 tab/document 归属，导航和移除不会自动替换成相似元素。AX 数据仍从 Chrome 读取，输出增量不意味着底层 CDP 事件已增量化。\n\n| 入口 | 定位 |\n| --- | --- |\n${table(PROGRAM_TOOL_REGISTRY)}\n\n## 可组合程序\n\nrun 接受 async JavaScript 函数体；简单操作直接调用，复杂工作可用变量、循环、条件、等待、过滤和断言。页面动作、脚本、网络、标签页、持久脚本与产物在同一程序中组合。同步循环运行在可销毁的 opaque-origin sandbox Worker，Side Panel 中介浏览器能力，jobs 不进入动作队列。没有新增 Chrome 权限，MV3 service worker 不 eval 模型字符串。\n\n\`\`\`js\nawait page.getByLabel('Email').fill('me@example.com');\nawait page.getByRole('button', { name: 'Sign in' }).click();\nawait page.getByText('Welcome me@example.com').waitFor({ state: 'visible' });\nawait check((await page.locator('output').innerText()).includes('Welcome'));\nreturn await page.inspect();\n\`\`\`\n\n\`\`\`text\n${PROGRAM_API}\n\`\`\`\n\n## 任务、回执与恢复\n\nrun(background=true) 返回 queued/accepted，不代表完成。jobs 的 after/nextCursor 使用 canonical event ID，可分页读取分步回执、emit 与终态结果。effectful 操作从 not-dispatched 到 dispatched-unknown，再到 completed；check 与显式等待通过才记录 verified。completed 表示操作返回，业务结果需要断言。动作在同一程序中排序，即使使用 Promise.all；事件先订阅再派发。原生对话框与选择器的回复可在等待中的点击期间执行。\n\n取消会销毁 Worker、撤销能力、清理浏览器输入和监听器，已经派发的请求可能有未知效果，不会回滚或盲目重试。关闭侧栏会取消全部作业；宿主丢失后持久记录变为 interrupted，不恢复任意 JS 调用栈或自动重放。所有状态、回执与产物来自同一个 canonical event log。\n\n截图、PDF 与文本默认是会话内部产物；用户明确请求保存或导出才调用 save。网络必须显式选择 page 或 extension 上下文，页面 CORS/凭据和扩展 host permissions 不自动互换。公开 CDP 限于绑定窗口内的 Page/DOM/Runtime/Accessibility/Network/Log/Input 与已知子会话；任意 JS、CDP 和 fetch 按有副作用处理。`;
if (process.argv.includes('--check')) {
  if (await readFile(path, 'utf8') !== content) throw new Error('Tool documentation is stale; run npm run docs:tools');
} else await writeFile(path, content);
