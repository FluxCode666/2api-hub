import Link from 'next/link';
export default function NotFound() { return <div className="panel stack"><h2>没有找到这个站点或渠道</h2><p className="muted">它可能已被移除，或不属于当前账号。</p><div><Link className="btn btn-primary" href="/merchant/sites">返回我的站点</Link></div></div>; }
