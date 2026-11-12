import type { FrozenSource } from './sources.ts';
export const nobelApi = 'https://api.nobelprize.org/2.1/nobelPrizes?limit=100&nobelPrizeYear=2000&yearTo=2023&nobelPrizeCategory=che';
export const summary = (year: number) => `https://www.nobelprize.org/prizes/chemistry/${year}/summary/`;
type Person = { id:string; knownName?:{en:string}; fullName?:{en:string}; portion:string };
type Award = {year:number; share:string; names:string[]; co:string[][]; source_url:string};
const names = (p: Person) => [...new Set([p.knownName?.en,p.fullName?.en].filter((x): x is string => typeof x === 'string' && !!x))];
const fraction = (value: unknown): [bigint, bigint] | null => {
  if (typeof value !== 'string' || value.length > 100 || !/^\d+\/\d+$/.test(value)) return null;
  const [numerator, denominator] = value.split('/').map(BigInt);
  return denominator > 0n && numerator > 0n && numerator <= denominator ? [numerator, denominator] : null;
};
const fractionValue = (value: string) => { const f = fraction(value); return f ? Number(f[0]) / Number(f[1]) : NaN; };
const sameFraction = (left: unknown, right: string) => { const a = fraction(left), b = fraction(right); return !!a && !!b && a[0] * b[1] === b[0] * a[1]; };
export function nobelOracle(source: FrozenSource) {
  const prizes = JSON.parse(source.body).nobelPrizes;
  if (!Array.isArray(prizes) || prizes.length !== 24) throw new Error('Blocked: incomplete Nobel years');
  const years = new Set<number>(); const people = new Map<string,Award[]>();
  for (const prize of prizes) {
    const year = Number(prize.awardYear); const ls: Person[] = prize.laureates;
    if (!Number.isInteger(year) || year < 2000 || year > 2023 || years.has(year) || prize.category?.en !== 'Chemistry' || !Array.isArray(ls) || !ls.length || ls.length > 3 || new Set(ls.map(p=>p.id)).size !== ls.length || ls.some(p=>!p.id || !names(p).length || !Number.isFinite(fractionValue(p.portion))) || Math.abs(ls.reduce((n,p)=>n+fractionValue(p.portion),0)-1)>1e-9) throw new Error('Blocked: incomplete Nobel prize data');
    years.add(year);
    for (const p of ls) { const awards = people.get(p.id) ?? []; awards.push({year,share:p.portion,names:names(p),co:ls.filter(q=>q.id!==p.id).map(names),source_url:summary(year)}); people.set(p.id,awards); }
  }
  return [...people.values()].filter(a=>a.length>1);
}
export function gradeNobel(answer: unknown, expected: ReturnType<typeof nobelOracle>) {
  const results = (answer as any)?.results;
  if (!Array.isArray(results) || results.length !== expected.length) return false;
  return expected.every(awards => {
    const matches = results.filter((r:any)=>awards.some(a=>a.names.includes(r?.name)));
    if (matches.length!==1 || !Array.isArray(matches[0].awards) || matches[0].awards.length!==awards.length) return false;
    return awards.every(a=> { const rows=matches[0].awards.filter((r:any)=>r?.year===a.year); if(rows.length!==1) return false; const r=rows[0]; return sameFraction(r.share,a.share) && r.source_url===a.source_url && Array.isArray(r.co_laureates) && r.co_laureates.length===a.co.length && a.co.every(n=>r.co_laureates.filter((x:unknown)=>typeof x==='string' && n.includes(x)).length===1); });
  });
}
