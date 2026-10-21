'use client';
import {useRef} from 'react';
import type {ReactNode} from 'react';
import gsap from 'gsap';
import {ScrollTrigger} from 'gsap/ScrollTrigger';
import {useGSAP} from '@gsap/react';
gsap.registerPlugin(ScrollTrigger,useGSAP);
export function Motion({children}:{children:ReactNode}){const root=useRef<HTMLDivElement>(null);useGSAP(()=>{const mm=gsap.matchMedia();mm.add('(prefers-reduced-motion: no-preference)',()=>{gsap.from('[data-hero-reveal]',{y:22,opacity:0,duration:.95,stagger:.12,ease:'power3.out'});gsap.utils.toArray<HTMLElement>('[data-reveal]').forEach(el=>{gsap.from(el,{y:30,opacity:0,duration:.85,ease:'power3.out',scrollTrigger:{trigger:el,start:'top 92%',once:true}})});const words=root.current?.querySelectorAll('.scrub-copy span');if(words?.length)gsap.fromTo(words,{opacity:.16},{opacity:1,stagger:.16,ease:'none',scrollTrigger:{trigger:'.scrub-copy',start:'top 85%',end:'bottom 55%',scrub:1}});});mm.add('(min-width: 900px) and (prefers-reduced-motion: no-preference)',()=>{if(root.current?.querySelector('.method-sticky'))ScrollTrigger.create({trigger:'.method-section',start:'top 150px',end:'bottom 550px',pin:'.method-sticky',pinSpacing:false});});return()=>mm.revert();},{scope:root});return <div ref={root}>{children}</div>}
