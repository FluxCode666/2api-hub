import Link from 'next/link';
import type {ModelSummary} from '@hub/shared';
import {serverApi} from '@/lib/api/server';
import {VerifyForm} from '@/components/verify-form';
import {Motion} from '@/components/motion';
export const metadata={title:'API 鉴定'};
export default async function Verify(){const models=await serverApi<ModelSummary[]>('/models');return <Motion><section className="hero container" style={{paddingBottom:65}}><div className="eyebrow" data-hero-reveal>API 鉴定工具</div><h1 className="max-w-6xl" data-hero-reveal style={{fontSize:'clamp(30px,4.5vw,61px)'}}>你连接的，<br/>是你想用的<em>那个模型吗？</em></h1><p data-hero-reveal>从协议特征到推理能力，用真实请求交叉验证。<br/>不凭一句自我介绍，就轻易下结论。</p><div className="hero-actions" data-hero-reveal><a href="#verify-tool" className="btn btn-primary">开始检测 ↓</a><Link href="/guide#trust" className="btn">了解检测依据 ↗</Link></div></section><div id="verify-tool" style={{scrollMarginTop:110}}><VerifyForm models={models}/></div><section className="container section"><p className="scrub-copy"><span>多一项检查，</span><span>多一份依据。</span><span>从可见的响应中，</span><span>寻找一致的模型信号。</span></p></section></Motion>}
