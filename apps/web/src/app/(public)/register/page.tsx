import {Card} from '@/components/ui/card';
import { pageMetadata } from '@/lib/seo';
import { AuthForm } from '@/components/auth-form';
export function generateMetadata() { return pageMetadata({ title: '注册账号', description: '创建 2API Hub 账号，收藏渠道、发表评价并申请站长入驻。', path: '/register', noIndex: true }); }
export default async function Register({ searchParams }: {
    searchParams: Promise<{
        next?: string;
    }>;
}) { const { next } = await searchParams; return <div className="container"><section className="auth-layout"><div className="eyebrow">从这里，建立连接</div><h1>找到好渠道的第一步。</h1><p>一个账号，收藏渠道、分享体验，也能申请站点入驻。</p><Card style={{ padding: 30 }} className="p-6"><AuthForm register next={next ?? '/me'}/></Card></section></div>; }
