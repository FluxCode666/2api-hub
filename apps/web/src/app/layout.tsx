import type {Metadata} from 'next';
import {GeistSans} from 'geist/font/sans';
import {GeistMono} from 'geist/font/mono';
import {Header} from '@/components/header';
import {SITE_URL} from '@/lib/seo';
import './globals.css';
export const metadata:Metadata={metadataBase:new URL(SITE_URL),title:{default:'2API Hub — 为每一次连接，找到更优解',template:'%s · 2API Hub'},description:'按模型挑选 AI 中转站渠道，比较实际价格、可用率、延迟与模型可信分。让每一次 API 连接，都有据可依。'};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="zh-CN" suppressHydrationWarning className={`${GeistSans.variable} ${GeistMono.variable}`}><head><script dangerouslySetInnerHTML={{__html:`try{document.documentElement.dataset.theme=localStorage.getItem('hub-theme')||'dark'}catch(e){}`}}/></head><body><Header/>{children}</body></html>}
