import {Card} from '@/components/ui/card';
import { pageMetadata } from '@/lib/seo';
import { AuthForm } from '@/components/auth-form';
export function generateMetadata() { return pageMetadata({ title: '登录', description: '登录 2API Hub，收藏优选 AI 中转渠道、分享体验或管理自己的站点。', path: '/login', noIndex: true }); }
export default async function Login({ searchParams }: {
    searchParams: Promise<{
        next?: string;
    }>;
}) { const { next } = await searchParams; return <div className="container"><section className="auth-layout"><div className="eyebrow">欢迎回来</div><h1>继续你的好连接。</h1><p>收藏优选渠道，管理站点，掌握最新动态。</p><Card style={{ padding: 30 }} className="p-6"><AuthForm next={next ?? '/me'}/></Card><p className="muted" style={{ fontSize: 10, marginTop: 20 }}>登录即表示你同意合理使用平台，不滥用检测接口，不提交他人的 API Key。</p></section></div>; }
