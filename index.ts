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

const productRoute = URL?.substring(URL?.lastIndexOf("/") + 1);

const imagesFolderPath = path.join(
  dirname(fileURLToPath(import.meta.url)),
  "../images"
);

const initDataFolderPath = path.join(
  dirname(fileURLToPath(import.meta.url)),
  "../initData"
);

const downloadFiles = async (
  fileName: string,
  urls: string[],
  folderPath: string
) => {
  for (let i = 0; i < urls.length; i++) {
    let extension = urls[i].match(/\.(\w+)(\?|$)/)?.[1];
    const url = urls[i].startsWith("http") ? urls[i] : `https:${urls[i]}`;
    try {
      const res = await fetchWithRetry(url);
      if (!res) throw new Error("No response");

      if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath);
      }

      const buffer = await res.arrayBuffer();
      if (!buffer) throw new Error("no buffer found");
      fs.writeFileSync(
        `${folderPath}/${fileName}${
          urls.length > 1 ? `-${i}` : ""
        }.${extension}`,
        Buffer.from(buffer)
      );

      console.log(`file downloaded`);
    } catch (error) {
      if (error instanceof Error) {
        console.log(error.message);
      }
    }
  }
};

const uploadFilesToFirebaseStorage = async (
  uploadTo: string,
  folderPath: string
) => {
  if (!fs.existsSync(folderPath)) return;

  const filesArr = fs.readdirSync(folderPath);

  const uploadPromises = filesArr.map((currentFile) => {
    return new Promise(
      (resolve: (fileData: { [name: string]: string }) => void, reject) => {
        const file = bucket.file(`${uploadTo}/${currentFile}`);

        const fileWriteStream = file.createWriteStream();

        fileWriteStream.on("error", (error) => {
          console.error(
            "Something is wrong! Unable to upload at the moment." + error
          );
          reject(error);
        });

        fileWriteStream.on("finish", async () => {
          const downloadUrl = await getDownloadURL(file);
          console.log(`File uploaded ${currentFile}`);
          resolve({
            [currentFile.match(/^.*(?=\.)/)?.[0] ?? "name"]: downloadUrl,
          });
        });

        fileWriteStream.end(
          fs.readFileSync(`${folderPath}/${currentFile}`),
          () => {
            fs.removeSync(`${folderPath}/${currentFile}`);
          }
        );
      }
    );
  });

  return await Promise.all(uploadPromises);
};

const updateRealTimeDataBaseWithColorsImgs = async (
  imagesUrls: string[],
  colorName: string,
  rgb: string,
  type: string,
  index: number
) => {
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
  await page.click(".HomepageCarouselArrow");
  try {
    await page.waitForSelector(".VideoPlayer__player > video", {
      timeout: 5000,
    });
  } catch (error) {
    console.log(`product has no video`);
  }

  const getProductObj = () => {
    return page.evaluate(() => {
      let imgsSrcFiltered: string[] = [];
      let rgbValue = "";

      const imgsEls = document.querySelectorAll<HTMLImageElement>(
        ".PdpCarouselWrapper__hero-gallery--thumbnails .Carousel img"
      );
      if (imgsEls.length > 1) {
        const imgsSrcArr = Array.from(imgsEls)
          .map((img) => img.getAttribute("data-src") ?? img.src)
          .filter((src) => !src?.includes("PDP"));

        imgsSrcFiltered = Array.from(new Set(imgsSrcArr));

        // to arrange the photos urls correctly because of the infinite carousel the first photo is the last one.
        if (imgsSrcFiltered.length > 0)
          imgsSrcFiltered.push(imgsSrcFiltered.shift() ?? "");
      }

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
        colorName,
        rgbValue,
        colorType,
      };
    });
  };

  const initProductData = await page.evaluate(() => {
    let videoSrc = "";
    let thumbnailSrc = "";

    const title = document.querySelector("h1")?.textContent ?? "N/A";

    const buttonsArr = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".ColorSwatchButton")
    );

    const videoEl = document.querySelector<HTMLVideoElement>(
      ".VideoPlayer__player > video"
    );

    if (videoEl) videoSrc = videoEl.src;

    const sidebarImgs = Array.from(
      document.querySelectorAll<HTMLImageElement>(".ThumbnailButton > img")
    );

    if (sidebarImgs) {
      const VideoThumbnailImgEl = sidebarImgs.find((img) =>
        img.getAttribute("data-testid")?.includes("video")
      );

      if (VideoThumbnailImgEl) {
        thumbnailSrc =
          VideoThumbnailImgEl.getAttribute("data-src") ??
          VideoThumbnailImgEl.src;
      }
    }

    const displayImgSrc =
      Array.from(
        document.querySelectorAll<HTMLImageElement>(
          ".PdpCarouselWrapper__hero-gallery--thumbnails .Carousel img"
        )
      )
        .find((img) => img.getAttribute("data-src")?.includes("PDP"))
        ?.getAttribute("data-src") ?? "";

    const colorsArr = Array.from(
      new Set(
        buttonsArr.map(
          (button) =>
            button.ariaLabel
              ?.match(/color\s+(.*?)\s+\(/)?.[1]
              ?.replace(/\s+|\//g, "-")
              ?.toLowerCase() ?? ""
        )
      )
    );

    return {
      colorsArr,
      title,
      initData: {
        video: videoSrc,
        videoThumbnail: thumbnailSrc,
        displayImg: displayImgSrc,
      },
    };
  });

  for (let [name, url] of Object.entries(initProductData.initData)) {
    await downloadFiles(name, [url], initDataFolderPath);
  }

  const filesDataArr = await uploadFilesToFirebaseStorage(
    `productsImages/${initProductData.title}`,
    initDataFolderPath
  );

  if (filesDataArr) {
    const productObjRef = database.ref("products");
    for (let file of filesDataArr) {
      await productObjRef.child(`${productRoute}`).update(file);
    }

    console.log(
      "updated realtime database with video, video thumbnail and display image"
    );
  }

  let colorPosition = 0;

  for (let i = 0; i < initProductData.colorsArr.length; i++) {
    try {
      const productObj = await getProductObj();
      if (
        !productObj.imgsSrcFiltered ||
        productObj.imgsSrcFiltered.length === 0 ||
        !initProductData.title
      ) {
        if (initProductData.colorsArr[i + 1]) {
          await page.goto(`${URL}-${initProductData.colorsArr[i + 1]}`, {
            waitUntil: "networkidle0",
            timeout: 0,
          });
        }
        continue;
      }

      await downloadFiles(
        initProductData.title,
        productObj.imgsSrcFiltered,
        imagesFolderPath
      );

      const imagesObjArr = await uploadFilesToFirebaseStorage(
        `productsImages/${initProductData.title}/${productObj.colorName}`,
        imagesFolderPath
      );

      if (!imagesObjArr)
        throw new Error("Uploading images to firebase storage failed");

      const imagesUrls = imagesObjArr.reduce((acc: string[], img) => {
        acc.push(Object.values(img)[0]);
        return acc;
      }, []);

      await updateRealTimeDataBaseWithColorsImgs(
        imagesUrls,
        productObj.colorName,
        productObj.rgbValue,
        productObj.colorType,
        colorPosition
      );

      colorPosition++;

      if (initProductData.colorsArr[i + 1]) {
        await page.goto(`${URL}-${initProductData.colorsArr[i + 1]}`, {
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
  console.log("Script Completed");
})();
