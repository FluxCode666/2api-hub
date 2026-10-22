import {readFile,writeFile} from 'node:fs/promises';
const themes=JSON.parse(await readFile(new URL('../src/lib/theme-tokens.json',import.meta.url),'utf8'));
const rgb=hex=>hex.slice(1).match(/../g).map(value=>parseInt(value,16)/255);
const luminance=color=>rgb(color).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4).reduce((sum,value,index)=>sum+value*[.2126,.7152,.0722][index],0);
const contrast=(a,b)=>{const values=[luminance(a),luminance(b)].sort((a,b)=>b-a);return (values[0]+.05)/(values[1]+.05)};
const mix=(a,b,ratio)=>'#'+rgb(a).map((value,index)=>Math.round((value*ratio+rgb(b)[index]*(1-ratio))*255).toString(16).padStart(2,'0')).join('');
const results=[];
for(const[theme,tokens]of Object.entries(themes)){
 const pairs=[];
 for(const surface of ['background','card','panel-high']){
  for(const text of ['foreground','muted-foreground','primary','success','warning','danger','unknown'])pairs.push([text,surface,tokens[text],tokens[surface],4.5]);
  pairs.push(['input边线',surface,tokens.input,tokens[surface],3]);
 }
 pairs.push(['primary-foreground','primary',tokens['primary-foreground'],tokens.primary,4.5]);
 pairs.push(['按钮hover文字','primary混入foreground 5%',tokens['primary-foreground'],mix(tokens.primary,tokens.foreground,.95),4.5]);
 for(const status of ['success','warning','danger']){
  pairs.push([status,'徽章底色5%',tokens[status],mix(tokens[status],tokens.card,.05),4.5]);
 }
 for(const[key,value]of Object.entries(tokens).filter(([key])=>key.startsWith('vendor-')))pairs.push([key,'panel-high',value,tokens['panel-high'],4.5]);
 for(const[label,surface,foreground,background,minimum]of pairs){const ratio=contrast(foreground,background);results.push({theme,label,surface,foreground,background,ratio:Number(ratio.toFixed(3)),minimum,pass:ratio>=minimum})}
}
console.table(results.map(({theme,label,surface,ratio,minimum,pass})=>({theme,组合:`${label} / ${surface}`,对比度:ratio,要求:minimum,通过:pass?'PASS':'FAIL'})));
const failures=results.filter(result=>!result.pass);
console.log(`${results.length-failures.length}/${results.length} 通过；最低文字对比度 ${Math.min(...results.filter(item=>item.minimum===4.5).map(item=>item.ratio)).toFixed(2)}:1`);
if(process.argv.includes('--save')){await writeFile(new URL('../artifacts/theme-paper/contrast.json',import.meta.url),JSON.stringify(results,null,2)+'\n')}
if(failures.length)process.exitCode=1;
