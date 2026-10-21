'use client';
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) { return <div className="panel stack"><h2>站点数据暂时无法加载</h2><p className="muted">请检查网络连接，稍后重试。</p><div><button className="btn" onClick={reset}>重新加载</button></div></div>; }
