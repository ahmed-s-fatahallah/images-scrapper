import puppeteer from "puppeteer";
import fs from "fs-extra";
import path, { dirname } from "path";
import { fetchWithRetry } from "./utils.js";
import { bucket, database } from "./firebaseInit.js";
import { getDownloadURL } from "firebase-admin/storage";
import { fileURLToPath } from "url";

const config = {
  defaultViewport: {
    width: 1920,
    height: 1080,
  },
} as const;

const URL =
  "https://www.allbirds.com/products/mens-tree-runner-go?price-tiers=msrp";

const imagesFolderPath = path.join(
  dirname(fileURLToPath(import.meta.url)),
  "../images"
);

const getProductDataWithPuppeteer = async () => {
  const browser = await puppeteer.launch(config);
  const page = await browser.newPage();
  await page.goto(URL);
  await page.waitForNetworkIdle();
  const productObj = await page.evaluate(() => {
    const imgsSrcArr = Array.from<HTMLImageElement>(
      document.querySelectorAll(".Carousel img")
    ).map((img) => {
      const src = img.getAttribute("data-src");
      if (src) return src;

      return "";
    });
    const imgsSrcFiltered = Array.from(new Set(imgsSrcArr));

    // to arrange the urls correctly
    imgsSrcFiltered.push(imgsSrcFiltered.shift() ?? "");

    const productRoute = window.location.pathname.split("/")[2];

    const title = document.querySelector("h1")?.textContent;

    const colorName =
      document.querySelector(".Overview__name")?.textContent ?? "";

    const colorBtnEl = document.querySelector(".ColorSwatch");

    let rgbValue = "";
    if (colorBtnEl) rgbValue = getComputedStyle(colorBtnEl)?.backgroundImage;
    const colorType =
      document
        .querySelector(".Overview__name")
        ?.previousSibling?.textContent?.substring(0, 7)
        ?.toLowerCase() ?? "";

    return {
      imgsSrcFiltered,
      title,
      productRoute,
      colorName,
      rgbValue,
      colorType,
    };
  }, []);

  await browser.close();
  return productObj;
};

const downloadImages = async (imgsSrcArr: string[], title: string) => {
  for (let i = 0; i < imgsSrcArr.length; i++) {
    const productImg = imgsSrcArr[i];
    if (productImg?.includes(".jpg")) continue;
    // const regex = /(https:\/\/.*\.(png|jpg))/;
    // const resultUrl = productImg?.match(regex)?.[0];
    try {
      const res = await fetchWithRetry(`https:${productImg}`, {});
      const buffer = await res?.arrayBuffer();

      if (!buffer) return;

      if (!fs.existsSync(imagesFolderPath)) {
        fs.mkdirSync(imagesFolderPath);
      }

      fs.writeFileSync(
        `${imagesFolderPath}/${title}-${i}.png`,
        Buffer.from(buffer)
      );
      console.log(`image downloaded-${i}`);
    } catch (error) {
      if (error instanceof Error) {
        console.log(error.message + " " + productImg);
      }
    }
  }
};

const uploadImagesToFireBaseStorage = async (title: string) => {
  if (!fs.existsSync(imagesFolderPath)) return;

  const imagesFilesArr = fs.readdirSync(imagesFolderPath);

  const uploadPromises = imagesFilesArr.map((imageFile) => {
    return new Promise((resolve: (downloadUrl: string) => void, reject) => {
      const file = bucket.file(`productsImages/${title}/${imageFile}`);

      const fileWriteStream = file.createWriteStream();

      fileWriteStream.on("error", (error) => {
        console.error(
          "Something is wrong! Unable to upload at the moment." + error
        );
        reject(error);
      });

      fileWriteStream.on("finish", async () => {
        const downloadUrl = await getDownloadURL(file);
        console.log(`Image uploaded ${imageFile}`);
        resolve(downloadUrl);
      });

      fileWriteStream.end(
        fs.readFileSync(`${imagesFolderPath}/${imageFile}`),
        () => {
          fs.removeSync(`${imagesFolderPath}/${imageFile}`);
        }
      );
    });
  });

  return await Promise.all(uploadPromises);
};

const updateDataBase = async (
  imagesUrls: string[],
  title: string,
  colorName: string,
  rgb: string,
  type: string,
  productRoute: string
) => {
  const productObjRef = database.ref("products");
  await productObjRef.child(`${productRoute}/colors/0/imgs`).set(imagesUrls);
  await productObjRef
    .child(`${productRoute}/colors/0`)
    .update({ colorName, rgb, type, sliderImg: imagesUrls[0] });
  await productObjRef.child(productRoute).update({ title });
  database.goOffline();

  console.log("Database Updated");
};

(async () => {
  const productObj = await getProductDataWithPuppeteer();
  if (!productObj.imgsSrcFiltered || !productObj.title) return;

  await downloadImages(productObj.imgsSrcFiltered, productObj.title);

  const imagesUrlsArr = await uploadImagesToFireBaseStorage(productObj.title);

  if (!imagesUrlsArr)
    throw new Error("Uploading images to firebase storage failed");

  await updateDataBase(
    imagesUrlsArr,
    productObj.title,
    productObj.colorName,
    productObj.rgbValue,
    productObj.colorType,
    productObj.productRoute
  );
})();
