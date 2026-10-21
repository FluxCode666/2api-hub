export type SearchValues=Record<string,string|string[]|undefined>;
export function searchString(values:SearchValues,change:Record<string,string|undefined>={}){const params=new URLSearchParams();for(const[k,v]of Object.entries({...values,...change})){if(typeof v==='string'&&v!=='')params.set(k,v)}return params.toString()}
