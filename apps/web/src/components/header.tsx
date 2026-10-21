'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect,useState } from 'react';
import { ArrowUpRight,ArrowsMerge,Sun,Moon,List,X,SignOut } from '@phosphor-icons/react';
import type { SessionUser } from '@hub/shared';
import { api } from '@/lib/api/client';
const links=[['/rankings','渠道榜单'],['/models','模型广场'],['/sites','站点目录'],['/verify','API 鉴定'],['/guide','使用指南']];
export function Logo(){return <Link href="/" className="logo" aria-label="2API Hub 首页"><ArrowsMerge size={29} weight="bold"/>2API<span>Hub</span></Link>}
export function Header(){
 const pathname=usePathname();const[light,setLight]=useState(false);const[menu,setMenu]=useState(false);const[user,setUser]=useState<SessionUser|null>(null);const[error,setError]=useState('');
 useEffect(()=>{setLight(document.documentElement.dataset.theme==='light');},[]);
 useEffect(()=>{setMenu(false);api<SessionUser>('/auth/me').then(setUser).catch(()=>setUser(null));},[pathname]);
 async function logout(){setError('');try{await api('/auth/logout',{method:'POST'});setUser(null);window.location.assign('/')}catch(e){setError(e instanceof Error?e.message:'退出失败，请稍后重试。')}}
 function toggle(){const next=!light;setLight(next);document.documentElement.dataset.theme=next?'light':'dark';localStorage.setItem('hub-theme',next?'light':'dark');}
 return <><a className="skip-link" href="#main">跳到主要内容</a><header className="site-header"><div className="container header-inner"><Logo/><nav className="nav-links" aria-label="主导航">{links.map(([href,label])=><Link href={href!} key={href} className={pathname.startsWith(href!)?'active':''}>{label}</Link>)}</nav><div className="header-actions"><button className="icon-btn" onClick={toggle} aria-label={light?'切换深色主题':'切换浅色主题'}>{light?<Moon size={17}/>:<Sun size={17}/>}</button>{user?<><Link className="btn btn-small login-button" href={user.role==='admin'?'/admin':'/me'}>{user.nickname}</Link><button className="icon-btn login-button" aria-label="退出登录" onClick={logout}><SignOut size={16}/></button></>:<Link href="/login" className="btn btn-small login-button">登录</Link>}<Link href="/join" className="btn btn-primary btn-small join-button">站长入驻<ArrowUpRight size={13}/></Link><button onClick={()=>setMenu(!menu)} aria-label={menu?'关闭菜单':'打开菜单'} aria-expanded={menu} className="icon-btn mobile-menu">{menu?<X size={19}/>:<List size={19}/>}</button></div></div>{menu&&<nav className="mobile-nav" aria-label="移动导航">{links.map(([href,label])=><Link key={href} href={href!}>{label}</Link>)}<Link href="/join">站长入驻</Link><Link href={user?'/me':'/login'}>{user?'个人中心':'登录 / 注册'}</Link><Link href="/merchant">站长工作台</Link>{user?.role==='admin'&&<Link href="/admin">管理后台</Link>}{user&&<button onClick={logout}>退出登录</button>}</nav>}</header>{error&&<div className="container notice notice-error" role="alert">{error}</div>}</>;
}
