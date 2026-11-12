import { canonicalUrl } from "./sources.ts";
import type { FrozenSource } from './sources.ts';
export const chromeDoc = 'https://developer.chrome.com/docs/extensions/reference/api/userScripts';
export const proposal = 'https://github.com/w3c/webextensions/issues/477';
export function userscriptsOracle(sources: FrozenSource[]) {
  const doc = sources.find(s => s.url === chromeDoc + '?hl=en')?.body.replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ') ?? '';
  const issue = sources.find(s => s.url === proposal)?.body ?? '';
  const checks = [/Availability\s+Chrome 120\+/i, /getWorldConfigurations\(\)\s+Chrome 133\+/i, /execute\(\)\s+Chrome 135\+/i, /Chrome versions prior to 138.{0,100}Developer mode/i, /Chrome versions 138 and newer.{0,100}Allow User Scripts/i, /browser\.\* since Chrome 148/i, /User scripts are cleared when an extension updates/i];
  if (checks.some(re => !re.test(doc)) || !/477/.test(issue) || !/proposal/i.test(issue) || !/user.?script/i.test(issue)) throw new Error('Blocked: userScripts evidence is incomplete or changed');
  return [120,133,135,138,148].map(v => ({ chrome_version:v, base_api:true, get_world_configurations:v>=133, execute:v>=135, user_toggle:v>=138?'allow_user_scripts':'developer_mode', browser_namespace:v>=148 }));
}
export function gradeUserscripts(answer: unknown, expected: ReturnType<typeof userscriptsOracle>) {
  if (!answer || typeof answer !== 'object') return false;
  const a = answer as any;
  return Array.isArray(a.versions) && a.versions.length === expected.length && expected.every(row => {
    const matches = a.versions.filter((x: any) => x?.chrome_version === row.chrome_version);
    return matches.length === 1 && Object.entries(row).every(([k,v]) => matches[0][k] === v);
  }) && a.scripts_cleared_on_extension_update === true && a.proposal_is_implementation_status === false && Array.isArray(a.sources) && [chromeDoc,proposal].every(u => a.sources.some((url: unknown) => typeof url === "string" && canonicalUrl(url) === canonicalUrl(u)));
}
