import type {Metadata} from 'next';
import {GeistSans} from 'geist/font/sans';
import {GeistMono} from 'geist/font/mono';
import {Header} from '@/components/header';
import {SITE_URL} from '@/lib/seo';
import {themes,themeCss} from '@/lib/theme';
import './globals.css';
import {ThemeProviders} from '@/components/theme-providers';

export const metadata:Metadata={metadataBase:new URL(SITE_URL),title:{default:'2API Hub — 为每一次连接，找到更优解',template:'%s · 2API Hub'},description:'按模型挑选 AI 中转站渠道，比较实际价格、可用率、延迟与模型可信分。让每一次 API 连接，都有据可依。'};
const themeInit=`(()=>{let t='light';try{if(localStorage.getItem('hub-theme')==='dark')t='dark'}catch{}document.documentElement.classList.toggle('dark',t==='dark');document.documentElement.dataset.theme=t;document.querySelector('meta[name="theme-color"]')?.setAttribute('content',t==='dark'?'${themes.dark.background}':'${themes.light.background}')})()`;
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="zh-CN" data-theme="light" suppressHydrationWarning className={`${GeistSans.variable} ${GeistMono.variable}`}><head><meta name="theme-color" content={themes.light.background}/><style dangerouslySetInnerHTML={{__html:themeCss}}/><script dangerouslySetInnerHTML={{__html:themeInit}}/></head><body><ThemeProviders><Header/>{children}</ThemeProviders></body></html>}
