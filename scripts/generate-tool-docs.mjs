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
const content = `# Surf Wax 工具参考

此文件由真实工具 registry 自动生成（npm run docs:tools）。新回合公开 ${PROGRAM_TOOL_REGISTRY.length} 个工具；每个独立工具对应一个操作，具体参数以工具 schema 为准。旧会话的 canonical 历史原样保留，历史工具名称不会因此重新成为可执行入口。

页面语义观察支持区域、字段、字符预算、分页、截断说明与增量。ref 带 tab/document 归属，导航和移除不会自动替换成相似元素。只有明确请求时才返回截图；AX 数据仍从 Chrome 读取，输出增量不意味着底层 CDP 事件已增量化。

| 工具 | 功能 |
| --- | --- |
${table(PROGRAM_TOOL_REGISTRY)}

## 可组合程序

\`execute_program\` 接受 async JavaScript 函数体，复杂工作可以使用变量、循环、条件、等待、过滤和断言。页面动作、脚本、网络、标签页、持久脚本与产物可在同一程序中组合。同步循环运行在可销毁的 opaque-origin sandbox Worker，Side Panel 中介浏览器能力，MV3 service worker 不 eval 模型字符串。

\`\`\`js
await page.getByLabel('Email').fill('me@example.com');
await page.getByRole('button', { name: 'Sign in' }).click();
await page.getByText('Welcome me@example.com').waitFor({ state: 'visible' });
await check((await page.locator('output').innerText()).includes('Welcome'));
return await page.inspect();
\`\`\`

\`\`\`text
${PROGRAM_API}
\`\`\`

## 任务、回执与恢复

后台执行返回 queued/accepted，不代表完成。\`list_jobs\`、\`get_job\` 和 \`cancel_job\` 管理任务；回执使用 canonical event ID 分页。已完成的动作表示操作返回，业务结果需要单独验证。程序内的动作按顺序执行，事件应在触发动作前订阅。原生对话框与选择器的回复可在等待中的点击期间执行。

独立工具可通过 \`subscribe_event\`、\`wait_event\` 和 \`unsubscribe_event\` 接收运行内事件。处理原生对话框时，先订阅，再以 \`background=true\` 触发动作，取得 dialogId 后调用 \`handle_dialog\`，最后用 \`get_job\` 确认作业终态。未确认终态的后台作业会阻止新的排队浏览器动作；事件等待、对话框应答与作业查询仍可执行。文件选择器事件目前仅提供元数据，需要在同一个 \`execute_program\` 中订阅、触发并设置文件；已保存产物可直接用 \`upload_file\` 上传至文件输入框。

取消会销毁 Worker、撤销能力、清理浏览器输入和监听器。已经派发的操作可能有未知效果，不会回滚或盲目重试。关闭侧栏会取消全部作业；宿主丢失后持久记录变为 interrupted，不恢复任意 JavaScript 调用栈或自动重放。状态、回执与产物来自同一个 canonical event log。

截图、PDF 与文本默认是会话内部产物；用户明确请求保存或导出时才保存。网络必须显式选择 page 或 extension 上下文，页面 CORS/凭据和扩展 host permissions 不自动互换。公开 CDP 绑定当前窗口中的页面及其已知子会话，不按 CDP 域限制；任意 JavaScript、CDP 和 fetch 按有副作用处理。`;
if (process.argv.includes('--check')) {
  if (await readFile(path, 'utf8') !== content) throw new Error('Tool documentation is stale; run npm run docs:tools');
} else await writeFile(path, content);
