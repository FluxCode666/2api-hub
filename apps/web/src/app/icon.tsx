import {ImageResponse} from 'next/og';
import {themes} from '@/lib/theme';
export const size={width:64,height:64};
export const contentType='image/png';
export default function Icon(){const colors=themes.light;return new ImageResponse(<div style={{display:'flex',width:64,height:64,alignItems:'center',justifyContent:'center',background:colors.background,borderRadius:16}}><svg width="46" height="46" viewBox="0 0 64 64"><path d="m18 16 14 16 14-16M32 32v17m-9-9 9 9 9-9" fill="none" stroke={colors.primary} strokeWidth="5" strokeLinecap="round" strokeLinejoin="round"/></svg></div>,size)}
