import Script from "next/script";

// Microsoft Clarity project ID. Public by design: it ships in the page script.
// Override per environment with NEXT_PUBLIC_CLARITY_ID if needed.
const CLARITY_ID = process.env.NEXT_PUBLIC_CLARITY_ID;

// Loads Clarity in production builds only, so local dev visits stay out of the data.
export function Clarity() {
  if (process.env.NODE_ENV !== "production") return null;
  // NEXT_PUBLIC_* is inlined at build time; without it the tag would load ".../tag/undefined".
  if (!CLARITY_ID) return null;

  // The LIFF URL carries access_token (and code/state after liff.login); LINE says never send it to logging
  // tools, so the snippet below skips every /liff page.
  return (
    <Script id="ms-clarity" strategy="beforeInteractive">
      {`(function(c,l,a,r,i,t,y){
        if(l.location.pathname.indexOf("/liff")===0)return;
        c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
        t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
        y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
      })(window, document, "clarity", "script", "${CLARITY_ID}");`}
    </Script>
  );
}
