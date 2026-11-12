import { IBM_Plex_Sans_Thai } from "next/font/google";

// Thai font of the public pages (homepage, privacy policy). Applied per page, not in the
// root layout, so the LIFF pages keep their own look.
export const thai = IBM_Plex_Sans_Thai({ subsets: ["thai", "latin"], weight: ["400", "600", "700"] });

/** Optional, set at build time: the LINE OA's add-friend link (https://line.me/R/ti/p/@...). */
export const ADD_FRIEND_URL = process.env.NEXT_PUBLIC_LINE_ADD_FRIEND_URL;
