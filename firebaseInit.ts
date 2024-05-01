import {
  initializeApp,
  cert,
  ServiceAccount,
  getApp,
  getApps,
} from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";

import myCred from "./react-http-47f95-firebase-adminsdk-ryepv-56ed444eb9.json" assert { type: "json" };

export const app =
  getApps.length > 0
    ? getApp()
    : initializeApp({
        credential: cert(myCred as ServiceAccount),
        storageBucket: "react-http-47f95.appspot.com",
      });

export const storage = getStorage();
export const bucket = storage.bucket();
