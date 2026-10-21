'use client';
export default function ErrorPage({retry}:{error:unknown;retry:()=>void}){return <div className="container" style={{paddingBlock:100}}><div className="notice notice-error"><h2 style={{fontSize:24}}>数据暂时无法加载</h2><p style={{margin:'15px 0'}}>请确认 API 服务可用，或稍后重试。</p><button className="btn" onClick={retry}>重新加载</button></div></div>}
