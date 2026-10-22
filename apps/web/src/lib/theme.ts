import themes from './theme-tokens.json';
export {themes};
export type Theme = keyof typeof themes;
const aliases={bg:'background',panel:'card',text:'foreground',line:'border',good:'success',warn:'warning',bad:'danger','accent-ink':'primary-foreground'} as const;
// CSS、OG 和 favicon 共用色板；Satori 不支持 CSS 变量，图片直接解析同源 token。
export const themeCss=Object.entries(themes).map(([name,tokens])=>`${name==='light'?':root,':'.dark,'}[data-theme="${name}"]{color-scheme:${name};${Object.entries(tokens).map(([key,value])=>`--${key}:${value}`).join(';')};${Object.entries(aliases).map(([key,target])=>`--${key}:var(--${target})`).join(';')}}`).join('');
export function vendorColor(slug:string|undefined){return slug?`var(--vendor-${slug}, var(--muted-foreground))`:'var(--muted-foreground)'}
