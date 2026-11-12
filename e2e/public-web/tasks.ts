import type { FrozenSource } from './sources.ts';
import { viteOracle, gradeViteFacts } from './vite-oracle.ts';
import { userscriptsOracle, gradeUserscripts, chromeDoc, proposal } from './userscripts-oracle.ts';
import { nobelOracle, gradeNobel, nobelApi, summary } from './nobel-oracle.ts';

type Read = (url:string)=>Promise<FrozenSource>;
const versions = ['5.4.0','6.0.0','7.0.0'];
const vitePages = versions.map(v=>`https://github.com/vitejs/vite/blob/v${v}/packages/vite/package.json`);
const viteApis = versions.map(v=>`https://registry.npmjs.org/vite/${v}`);
const nobelList = 'https://www.nobelprize.org/prizes/lists/all-nobel-prizes-in-chemistry/';
async function collect(read:Read, urls:string[]) { const sources=await Promise.all(urls.map(read)); if(sources.some(s=>s.status<200 || s.status>=300 || !s.body.trim())) throw new Error('Blocked: source unavailable'); return sources; }
export const publicTasks = [
  {
    id:'vite-node-historical-intersection', title:'Vite 历史版本的 Node 兼容性交集', difficulty:'hard', startUrl:vitePages[0],
    prompt:`可使用扩展提供的网页或公开 HTTP 读取工具获取真实来源，引用必须对应实际读取证据。请浏览 GitHub 上 Vite 5.4.0、6.0.0、7.0.0 各自 tag 的 packages/vite/package.json，核对发布包的 Node 引擎声明。逐一判断 Node 18.20.0、20.18.0、20.19.0、21.7.0、22.11.0、22.12.0 是否满足，列出 engines.node、直接依赖 esbuild 和 rollup 的声明范围，再选择同时接受 18.20.0、20.18.0、22.11.0 的最高候选版本。每个候选引用对应 GitHub 文件来源，保留范围原文，不把范围当成已安装版本。最终用 json 代码块返回：{candidates:[{vite_version:string,node_engine:string,node_compatibility:{"18.20.0":boolean,"20.18.0":boolean,"20.19.0":boolean,"21.7.0":boolean,"22.11.0":boolean,"22.12.0":boolean},dependencies:{esbuild:string,rollup:string},sources:[URL]}],highest_matching_candidate:string}。`,
    evidenceUrls(url: string) { return [url.replace('https://github.com/vitejs/vite/blob/', 'https://raw.githubusercontent.com/vitejs/vite/')]; },
    evidenceTerms(expected: unknown, url: string) { const row = (expected as ReturnType<typeof viteOracle>).find(row => url.includes('/v' + row.vite_version + '/'))!; return ['engines', row.node_engine, 'esbuild', row.dependencies.esbuild, 'rollup', row.dependencies.rollup]; },
    async prepare(read:Read) { const sources=await collect(read,[...viteApis,...vitePages]); const expected=viteOracle(sources.slice(0,3)); for(let i=0;i<3;i++) if(!sources[i+3].body.includes(versions[i]) || !sources[i+3].body.includes('esbuild') || !sources[i+3].body.includes('rollup')) throw new Error('Blocked: Vite page incomplete'); return {sources,expected,requiredUrls:vitePages}; },
    grade(answer:unknown, expected:unknown) { return gradeViteFacts(answer,expected as ReturnType<typeof viteOracle>); }
  },
  {
    id:'mv3-userscripts-version-boundaries', title:'Chrome userScripts 版本与能力边界', difficulty:'hard', startUrl:chromeDoc,
    prompt:`可使用扩展提供的网页或公开 HTTP 读取工具获取真实来源，引用必须对应实际读取证据。请浏览 Chrome userScripts 官方文档，以及 W3C 历史提案 https://github.com/w3c/webextensions/issues/477 。针对 Chrome 120、133、135、138、148，分别核查基础 API、getWorldConfigurations()、execute() 和 browser.* 命名空间是否可用，以及用户需要开启 developer_mode 还是 allow_user_scripts。区分具体方法与独立 world 配置概念。核查扩展更新是否清空已注册脚本，以及仅凭提案本身能否确定实际实现状态。附上官方文档和提案来源（文档来源使用不带语言参数的规范 URL）。最终用 json 代码块返回：{versions:[{chrome_version:number,base_api:boolean,get_world_configurations:boolean,execute:boolean,user_toggle:"developer_mode"|"allow_user_scripts",browser_namespace:boolean}],scripts_cleared_on_extension_update:boolean,proposal_is_implementation_status:boolean,sources:[URL]}。`,
    evidenceUrls(_url: string) { return [] as string[]; },
    evidenceTerms(_expected: unknown, url: string) { return url === proposal ? ['user', 'script', 'proposal'] : ['getWorldConfigurations', '133', 'execute', '135', '138', '148', 'cleared']; },
    async prepare(read:Read) { const requiredUrls=[chromeDoc,proposal]; const sources=await collect(read,[...requiredUrls,chromeDoc + "?hl=en"]); return {sources,expected:userscriptsOracle(sources),requiredUrls}; },
    grade(answer:unknown,expected:unknown) { return gradeUserscripts(answer,expected as ReturnType<typeof userscriptsOracle>); }
  },
  {
    id:'nobel-chemistry-repeat-laureates', title:'2000–2023 年化学奖重复获奖者关联', difficulty:'medium', startUrl:nobelList,
    prompt:`可使用扩展提供的网页或公开 HTTP 读取工具获取真实来源，引用必须对应实际读取证据。请浏览诺贝尔奖官网，找出 2000 至 2023 年（含首尾）至少两次获得化学奖的所有人。对每个人列出区间内每次获奖的年份、个人份额、当年所有其他共同获奖者，以及当年官方 summary 页面链接。确认区间内结果集合完整，核对每个获奖年份的原始详情。最终用 json 代码块返回：{results:[{name:string,awards:[{year:number,share:string,co_laureates:[string],source_url:URL}]}]}。`,
    evidenceUrls(_url: string) { return [nobelApi]; },
    evidenceTerms(expected: unknown, url: string) { const award = (expected as ReturnType<typeof nobelOracle>).flat().find(award => award.source_url === url)!; return [...award.names.slice(0, 1).map(name => name.split(' ').at(-1)!), award.share, ...award.co.map(names => names[0].split(' ').at(-1)!)]; },
    async prepare(read:Read) { const requiredUrls=[summary(2001),summary(2022)]; const sources=await collect(read,[nobelApi,nobelList,...requiredUrls]); if(!/chemistry/i.test(sources[1].body) || !/2001/.test(sources[2].body) || !/2022/.test(sources[3].body) || !/Sharpless/i.test(sources[2].body) || !/Sharpless/i.test(sources[3].body)) throw new Error('Blocked: Nobel pages incomplete'); return {sources,expected:nobelOracle(sources[0]),requiredUrls}; },
    grade(answer:unknown,expected:unknown) { return gradeNobel(answer,expected as ReturnType<typeof nobelOracle>); }
  }
];
