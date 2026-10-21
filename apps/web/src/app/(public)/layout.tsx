import {Footer} from '@/components/footer';
export default function PublicLayout({children}:{children:React.ReactNode}){return <><main id="main" className="public-main">{children}</main><Footer/></>}
