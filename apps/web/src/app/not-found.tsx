import Link from 'next/link';
export default function NotFound(){return <main id="main" className="container" style={{paddingBlock:120,textAlign:'center'}}><div className="eyebrow">404</div><h1>这条连接暂时不存在</h1><p style={{margin:'20px 0 30px'}}>页面可能已移动，或该资源尚未公开。</p><Link href="/rankings" className="btn btn-primary">探索可用渠道</Link></main>}
