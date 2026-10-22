'use client';
import {Button} from '@/components/ui/button';
import {Alert} from '@/components/ui/alert';
export default function ErrorPage({ retry }: {
    error: unknown;
    retry: () => void;
}) { return <div className="container" style={{ paddingBlock: 100 }}><Alert className="border-danger text-danger"><h2 style={{ fontSize: 24 }}>数据暂时无法加载</h2><p style={{ margin: '15px 0' }}>请确认 API 服务可用，或稍后重试。</p><Button onClick={retry} variant="outline">重新加载</Button></Alert></div>; }
