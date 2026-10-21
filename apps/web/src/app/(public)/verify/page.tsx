import {pageMetadata} from '@/lib/seo';
import Link from 'next/link';
import type {ModelSummary} from '@hub/shared';
import {publicApi} from '@/lib/api/public';
import {VerifyForm} from '@/components/verify-form';
import {Motion} from '@/components/motion';
export function generateMetadata(){return pageMetadata({title:'API 模型真伪鉴定与可信度检测工具',description:'输入接口地址、模型和临时 API Key，交叉检测连通性、模型回显、协议特征、Token 计数与推理能力，查看逐项模型可信报告。',path:'/verify'});}
export default async function Verify(){const models=await publicApi<ModelSummary[]>('/models');return <Motion><section className="hero container" style={{paddingBottom:65}}><div className="eyebrow" data-hero-reveal>API 鉴定工具</div><h1 className="max-w-6xl" data-hero-reveal style={{fontSize:'clamp(30px,4.5vw,61px)'}}>你连接的，<br/>是你想用的<em>那个模型吗？</em></h1><p data-hero-reveal>从协议特征到推理能力，用真实请求交叉验证。<br/>不凭一句自我介绍，就轻易下结论。</p><div className="hero-actions" data-hero-reveal><a href="#verify-tool" className="btn btn-primary">开始检测 ↓</a><Link href="/guide#trust" className="btn">了解检测依据 ↗</Link></div></section><div id="verify-tool" style={{scrollMarginTop:110}}><VerifyForm models={models}/></div><section className="container section"><p className="scrub-copy"><span>多一项检查，</span><span>多一份依据。</span><span>从可见的响应中，</span><span>寻找一致的模型信号。</span></p></section></Motion>}

export const revalidate = 300;
