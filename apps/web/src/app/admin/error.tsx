'use client';

import { ArrowClockwiseIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

export default function AdminError({ reset }: { reset: () => void }) {
  return <div className="space-y-4"><Alert variant="destructive"><WarningCircleIcon /><AlertTitle>管理数据暂时无法加载</AlertTitle><AlertDescription>请检查服务连接后重试。</AlertDescription></Alert><Button variant="outline" onClick={reset}><ArrowClockwiseIcon />重新加载</Button></div>;
}
