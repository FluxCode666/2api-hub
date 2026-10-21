'use client';

export default function AdminError({ reset }: { reset: () => void }) {
  return <div className="panel stack"><h2>管理数据暂时无法加载</h2><p className="muted">请检查服务连接后重试。</p><button className="btn" onClick={reset}>重新加载</button></div>;
}
