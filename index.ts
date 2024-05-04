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

// Pass the product url as an argument from the terminal
const URL = process.argv.find((arg) => arg.includes("http"));

const imagesFolderPath = path.join(
  dirname(fileURLToPath(import.meta.url)),
  "../images"
);

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

const uploadImagesToFireBaseStorage = async (
  title: string,
  colorName: string
) => {
  if (!fs.existsSync(imagesFolderPath)) return;

  const imagesFilesArr = fs.readdirSync(imagesFolderPath);

  const uploadPromises = imagesFilesArr.map((imageFile) => {
    return new Promise((resolve: (downloadUrl: string) => void, reject) => {
      const file = bucket.file(
        `productsImages/${title}/${colorName}/${imageFile}`
      );

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

const updateRealTimeDataBase = async (
  imagesUrls: string[],
  colorName: string,
  rgb: string,
  type: string,
  productTitle: string,
  index: number
) => {
  const productRoute = productTitle
    .replaceAll("'", "")
    .replaceAll(" ", "-")
    ?.toLowerCase();
  const productObjRef = database.ref("products");
  await productObjRef
    .child(`${productRoute}/colors/${index}/imgs`)
    .set(imagesUrls);
  await productObjRef
    .child(`${productRoute}/colors/${index}`)
    .update({ colorName, rgb, type, sliderImg: imagesUrls[0] });

  console.log(`Database Updated-${index}`);
};

(async () => {
  if (!URL) return;

  const browser = await puppeteer.launch(config);
  const page = await browser.newPage();
  await page.goto(URL, { waitUntil: "networkidle0", timeout: 0 });

  await page.click(".Modal__close");

  const getProductObj = () => {
    return page.evaluate(() => {
      let imgsSrcFiltered: string[] = [];
      let rgbValue = "";

      const carouselWrapper = document.querySelector<HTMLDivElement>(
        ".PdpCarouselWrapper__hero-gallery--thumbnails"
      );
      if (carouselWrapper) {
        const imgsSrcArr = Array.from<HTMLImageElement>(
          carouselWrapper.querySelectorAll(".Carousel img")
        ).map((img) => {
          const src = img.getAttribute("data-src");
          if (src) return src;

          return "";
        });
        imgsSrcFiltered = Array.from(new Set(imgsSrcArr));

        // to arrange the photos urls correctly because of the infinite carousel the first photo is the last one.
        imgsSrcFiltered.push(imgsSrcFiltered.shift() ?? "");
      }

      const title = document.querySelector("h1")?.textContent;

      const colorName =
        document.querySelector(".Overview__name")?.textContent ?? "";

      const colorBtnEl = document.querySelector(
        ".ColorSwatchButton--active > .ColorSwatch"
      );

      if (colorBtnEl) {
        const colorBtnElStyles = getComputedStyle(colorBtnEl);
        rgbValue =
          colorBtnElStyles.backgroundImage !== "none"
            ? colorBtnElStyles.backgroundImage
            : colorBtnElStyles.backgroundColor;
      }
      const colorType =
        document
          .querySelector(".Overview__name")
          ?.previousSibling?.textContent?.substring(0, 7)
          ?.toLowerCase() ?? "";

      return {
        imgsSrcFiltered,
        title,
        colorName,
        rgbValue,
        colorType,
      };
    });
  };

  const colorsArray = await page.evaluate(() => {
    const buttonsArr = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".ColorSwatchButton")
    );
    return buttonsArr.map((button) =>
      button.ariaLabel
        ?.match(/color\s+(.*?)\s+\(/)?.[1]
        ?.replace(" ", "-")
        ?.toLowerCase()
    );
  });

  for (let i = 0; i < colorsArray.length; i++) {
    try {
      const productObj = await getProductObj();
      if (!productObj.imgsSrcFiltered || !productObj.title) return;
      await downloadImages(productObj.imgsSrcFiltered, productObj.title);
      const imagesUrlsArr = await uploadImagesToFireBaseStorage(
        productObj.title,
        productObj.colorName
      );
      if (!imagesUrlsArr)
        throw new Error("Uploading images to firebase storage failed");
      await updateRealTimeDataBase(
        imagesUrlsArr,
        productObj.colorName,
        productObj.rgbValue,
        productObj.colorType,
        productObj.title,
        i
      );

      if (colorsArray[i + 1]) {
        await page.goto(`${URL}-${colorsArray[i + 1]}`, {
          waitUntil: "networkidle0",
          timeout: 0,
        });
      }
    } catch (error) {
      if (error instanceof Error)
        console.log(`message: ${error.message}/ cause: ${error.cause}`);
    }
  }

  await browser.close();
  await database.app.delete();
})();
