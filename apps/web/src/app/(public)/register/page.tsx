import {AuthForm} from '@/components/auth-form';
export const metadata={title:'注册'};
export default async function Register({searchParams}:{searchParams:Promise<{next?:string}>}){const{next}=await searchParams;return <div className="container"><section className="auth-layout"><div className="eyebrow">从这里，建立连接</div><h1>找到好渠道的第一步。</h1><p>一个账号，收藏渠道、分享体验，也能申请站点入驻。</p><div className="panel" style={{padding:30}}><AuthForm register next={next??'/me'}/></div></section></div>}
