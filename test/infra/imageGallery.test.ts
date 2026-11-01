import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteRandomImageFile,
  ensureRandomImageDirectory,
  isRandomImageDirectory,
  listRandomImageGalleryEntries,
  pickRandomImage,
  readRandomImageLibrary,
  statRandomImageFile,
  storeRandomImage,
} from "../../packages/infra/imageGallery";
import {
  randomImageDirectoryCache,
  randomImageGalleryCache,
} from "../../packages/cache/main/hImage";
import { RANDOM_IMAGE_CONTENT_NAME_PATTERN, RANDOM_IMAGE_MAX_BYTES } from "../../packages/consts/imageGallery";
import { ASSETS_CONFIG_PATH } from "../../packages/consts/paths";
import { RANDOM_H_IMAGE_DIR_FIELD } from "../../packages/consts/ui/assets";
import type { RandomImageLibrary, RandomImagePick, StoreRandomImageResult } from "../../packages/types/imageGallery";

const roots: string[] = [];

function temporaryRoot(): string {
  const root: string = mkdtempSync(join(tmpdir(), "copy-ninjia-random-image-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  randomImageDirectoryCache.current = null;
  randomImageGalleryCache.current = null;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ensureRandomImageDirectory", () => {
  test("目录不存在时逐级创建", async () => {
    const directory: string = join(temporaryRoot(), "nested", "images");
    await ensureRandomImageDirectory(directory);
    expect((await Bun.file(directory).stat()).isDirectory()).toBe(true);
  });

  test("已存在的目录与指向目录的符号链接原样放行", async () => {
    const root: string = temporaryRoot();
    const real: string = join(root, "real");
    mkdirSync(real);
    await Bun.write(join(real, `${"a".repeat(64)}.png`), "x");
    const link: string = join(root, "link");
    symlinkSync(real, link);
    await ensureRandomImageDirectory(real);
    await ensureRandomImageDirectory(link);
    expect(await Bun.file(join(real, `${"a".repeat(64)}.png`)).text()).toBe("x");
  });

  test("路径是文件时拒绝，诊断写明 assets.json、字段与解析后的路径", async () => {
    const file: string = join(temporaryRoot(), "images");
    await Bun.write(file, "not a directory");
    await expect(ensureRandomImageDirectory(file)).rejects.toThrow(
      `${ASSETS_CONFIG_PATH}: ${RANDOM_H_IMAGE_DIR_FIELD} must be an accessible existing or creatable directory (resolved to ${file}).`
    );
  });

  test("上级路径是文件时拒绝", async () => {
    const file: string = join(temporaryRoot(), "parent");
    await Bun.write(file, "x");
    await expect(ensureRandomImageDirectory(join(file, "images"))).rejects.toThrow(
      `${RANDOM_H_IMAGE_DIR_FIELD} must be an accessible existing or creatable directory`
    );
  });

  test("目录不存在且创建失败时拒绝（procfs 不允许建目录，root 也一样）", async () => {
    await expect(ensureRandomImageDirectory("/proc/copy-ninjia-random-image-test/images")).rejects.toThrow(
      `${RANDOM_H_IMAGE_DIR_FIELD} must be an accessible existing or creatable directory`
    );
  });
});

/** 各格式的最小文件头；只用于嗅探，不是完整图片。 */
const JPEG: Uint8Array = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
const PNG: Uint8Array = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const GIF: Uint8Array = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1]);

describe("readRandomImageLibrary", () => {
  test("张数口径同抽图候选：隐藏文件、收图临时文件、非白名单扩展名、子目录与符号链接都不算", async () => {
    const root: string = temporaryRoot();
    for (const name of ["a.jpg", "B.PNG", "c.webp", "d.jpeg", ".hidden.png", ".h_image-add-123.jpg", "notes.txt", "anim.gif", "target.png"]) {
      await Bun.write(join(root, name), "x");
    }
    mkdirSync(join(root, "sub.png"));
    symlinkSync(join(root, "target.png"), join(root, "link.png"));
    expect((await readRandomImageLibrary(root)).size).toBe(5);
    expect((await readRandomImageLibrary(temporaryRoot())).size).toBe(0);
  });

  test("张数口径与抽图候选一致，手工放进来的图照样计数", async () => {
    const root: string = temporaryRoot();
    await storeRandomImage(root, JPEG);
    await storeRandomImage(root, PNG);
    for (const name of ["manual.jpg", "0199ffff-ffff-7fff-bfff-ffffffffffff.png"]) await Bun.write(join(root, name), "x");

    const library: RandomImageLibrary = await readRandomImageLibrary(root);
    expect(library.size).toBe(4);
  });

  test("目录读取失败原样上抛", async () => {
    await expect(readRandomImageLibrary(join(temporaryRoot(), "missing"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("pickRandomImage", () => {
  test("目录缺失或不是目录时报 missingDirectory", async () => {
    const root: string = temporaryRoot();
    expect(await pickRandomImage(join(root, "absent"))).toEqual({ status: "missingDirectory" });
    await Bun.write(join(root, "file"), "x");
    expect(await pickRandomImage(join(root, "file"))).toEqual({ status: "missingDirectory" });
  });

  test("只认非隐藏普通文件与白名单扩展名，其余一律不是候选", async () => {
    const root: string = temporaryRoot();
    await Bun.write(join(root, ".hidden.png"), "x");
    await Bun.write(join(root, "notes.txt"), "x");
    await Bun.write(join(root, "anim.gif"), "x");
    mkdirSync(join(root, "sub.png"));
    await Bun.write(join(root, "target.png"), "x");
    symlinkSync(join(root, "target.png"), join(root, "link.png"));
    await Bun.file(join(root, "target.png")).delete();
    expect(await pickRandomImage(root)).toEqual({ status: "empty" });
  });

  test("扩展名不分大小写，返回原文件名、对应 MIME 与字节", async () => {
    const root: string = temporaryRoot();
    await Bun.write(join(root, "Photo.WEBP"), new Uint8Array([1, 2, 3]));
    const pick: RandomImagePick = await pickRandomImage(root);
    expect(pick).toEqual({
      status: "ok",
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/webp",
      fileName: "Photo.WEBP",
    });
  });

  test("按均匀随机下标选取候选", async () => {
    const root: string = temporaryRoot();
    for (const name of ["a.jpg", "b.jpeg", "c.png"]) await Bun.write(join(root, name), name);
    const random = spyOn(Math, "random");
    try {
      const picked: string[] = [];
      for (const value of [0, 0.5, 0.99]) {
        random.mockReturnValueOnce(value);
        const pick: RandomImagePick = await pickRandomImage(root);
        if (pick.status !== "ok") throw new Error(`unexpected ${pick.status}`);
        picked.push(new TextDecoder().decode(pick.bytes));
      }
      expect(new Set(picked).size).toBe(3);
    } finally {
      random.mockRestore();
    }
  });

  test("抽中的文件在读取前消失时从剩余候选重抽，抽完报 empty", async () => {
    const root: string = temporaryRoot();
    await Bun.write(join(root, "a.png"), "a");
    await Bun.write(join(root, "b.png"), "b");
    const random = spyOn(Math, "random").mockReturnValue(0);
    const realFile: typeof Bun.file = Bun.file;
    const gone: Error = Object.assign(new Error("gone"), { code: "ENOENT" });
    const file = spyOn(Bun, "file").mockImplementation(((path: string) => path.endsWith("a.png")
      ? { stat: async (): Promise<never> => { throw gone; } }
      : realFile(path)) as unknown as typeof Bun.file);
    try {
      const pick: RandomImagePick = await pickRandomImage(root);
      expect(pick).toMatchObject({ status: "ok", fileName: "b.png" });
      await Bun.write(join(root, "b.png"), "b");
      file.mockImplementation((() => ({ stat: async (): Promise<never> => { throw gone; } })) as unknown as typeof Bun.file);
      expect(await pickRandomImage(root)).toEqual({ status: "empty" });
    } finally {
      file.mockRestore();
      random.mockRestore();
    }
  });

  test("抽中超过上限的文件时从剩余候选重抽", async () => {
    const root: string = temporaryRoot();
    await Bun.write(join(root, "huge.jpg"), new Uint8Array(RANDOM_IMAGE_MAX_BYTES + 1));
    await Bun.write(join(root, "ok.png"), "ok");
    const order: readonly string[] = readdirSync(root).sort();
    const random = spyOn(Math, "random");
    try {
      // 先抽中超限的那张，剔除后剩余候选只有一项，下标恒为 0。
      random.mockReturnValueOnce(order.indexOf("huge.jpg") / order.length).mockReturnValue(0);
      const pick: RandomImagePick = await pickRandomImage(root);
      if (pick.status !== "ok") throw new Error(`unexpected ${pick.status}`);
      expect(pick.fileName).toBe("ok.png");
      expect(new TextDecoder().decode(pick.bytes)).toBe("ok");
    } finally {
      random.mockRestore();
    }
  });

  test("候选全部超过上限时报超限并点名最后抽中的那张，不读入内存", async () => {
    const root: string = temporaryRoot();
    await Bun.write(join(root, "huge.jpg"), new Uint8Array(RANDOM_IMAGE_MAX_BYTES + 1));
    const bytes = spyOn(Blob.prototype, "bytes");
    try {
      expect(await pickRandomImage(root)).toEqual({ status: "tooLarge", fileName: "huge.jpg" });
      expect(bytes).not.toHaveBeenCalled();
    } finally {
      bytes.mockRestore();
    }
  });
});

describe("收图写盘", () => {
  test("文件名是内容 SHA-256 加嗅探出的扩展名，不留临时文件，写入后能被抽中", async () => {
    const root: string = temporaryRoot();
    const jpeg: StoreRandomImageResult = await storeRandomImage(root, JPEG);
    const png: StoreRandomImageResult = await storeRandomImage(root, PNG);
    expect(jpeg).toEqual({ status: "stored", fileName: `${Bun.SHA256.hash(JPEG, "hex")}.jpg` });
    expect(png).toEqual({ status: "stored", fileName: `${Bun.SHA256.hash(PNG, "hex")}.png` });
    expect(readdirSync(root)).toHaveLength(2);
    for (const name of readdirSync(root)) {
      expect(RANDOM_IMAGE_CONTENT_NAME_PATTERN.test(name.slice(0, name.lastIndexOf(".")))).toBe(true);
    }
    expect(Array.from(await Bun.file(join(root, (jpeg as { fileName: string }).fileName)).bytes())).toEqual(Array.from(JPEG));
    expect((await pickRandomImage(root)).status).toBe("ok");
  });

  test("同一份内容再收一次报 existing，不重复写盘也不改动已有那份", async () => {
    const root: string = temporaryRoot();
    const first: StoreRandomImageResult = await storeRandomImage(root, JPEG);
    const stat = await Bun.file(join(root, (first as { fileName: string }).fileName)).stat();
    const second: StoreRandomImageResult = await storeRandomImage(root, JPEG);
    expect(second).toEqual({ status: "existing", fileName: (first as { fileName: string }).fileName });
    expect(readdirSync(root)).toEqual([(first as { fileName: string }).fileName]);
    expect((await Bun.file(join(root, (first as { fileName: string }).fileName)).stat()).mtimeMs).toBe(stat.mtimeMs);
  });

  test("不是 jpeg、png、webp 的字节不写入", async () => {
    const root: string = temporaryRoot();
    expect(await storeRandomImage(root, GIF)).toEqual({ status: "unsupportedFormat" });
    expect(readdirSync(root)).toEqual([]);
  });

  test("改名失败时删掉临时文件并原样上抛", async () => {
    const root: string = temporaryRoot();
    // 目标名已被一个目录占着，rename 会失败；目录不是普通文件，exists() 为 false。
    const target: string = `${Bun.SHA256.hash(JPEG, "hex")}.jpg`;
    mkdirSync(join(root, target));
    await expect(storeRandomImage(root, JPEG)).rejects.toThrow();
    expect(readdirSync(root)).toEqual([target]);
  });

  test("目录判定跟随符号链接，不存在或是文件都不算目录", async () => {
    const root: string = temporaryRoot();
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "link"));
    await Bun.write(join(root, "file.txt"), "x");
    expect(await isRandomImageDirectory(join(root, "link"))).toBe(true);
    expect(await isRandomImageDirectory(join(root, "file.txt"))).toBe(false);
    expect(await isRandomImageDirectory(join(root, "missing"))).toBe(false);
  });
});

test("专用图库拒绝非法名称、扩展名、子目录与文件链接，失败不改源", async () => {
  for (const name of ["ordinary.jpg", `${"a".repeat(63)}.png`, `${"A".repeat(64)}.jpg`, `${"a".repeat(64)}.gif`, ".DS_Store", ".h_image-add-interrupted.png"]) {
    const root: string = temporaryRoot();
    const path: string = join(root, name);
    await Bun.write(path, "preserve");
    await expect(ensureRandomImageDirectory(root)).rejects.toThrow(`${path}: ${RANDOM_H_IMAGE_DIR_FIELD}`);
    expect(await Bun.file(path).text()).toBe("preserve");
  }
  for (const link of [true, false]) {
    const root: string = temporaryRoot();
    const path: string = join(root, `${"a".repeat(64)}.png`);
    if (link) symlinkSync(join(root, "absent"), path);
    else mkdirSync(path);
    await expect(ensureRandomImageDirectory(root)).rejects.toThrow(path);
    expect(readdirSync(root)).toEqual([`${"a".repeat(64)}.png`]);
  }
});

test("专用图库启动检查命名而不重算内容，悬空目录根拒绝", async () => {
  const root: string = temporaryRoot();
  for (const extension of ["jpg", "jpeg", "png", "WEBP"]) await Bun.write(join(root, `${"a".repeat(64)}.${extension}`), "not read during validation");
  await ensureRandomImageDirectory(root);
  const link: string = join(temporaryRoot(), "dangling");
  symlinkSync(join(root, "absent"), link);
  await expect(ensureRandomImageDirectory(link)).rejects.toThrow(RANDOM_H_IMAGE_DIR_FIELD);
});

/**
 * 读取当前 Mini App 图库缓存的文件名顺序。
 * @returns 缓存项文件名列表；缓存为 null 时返回 null。
 */
function galleryCacheNames(): string[] | null {
  return randomImageGalleryCache.current?.entries.map((entry): string => entry.fileName) ?? null;
}

/**
 * 把文件的访问与修改时间设为指定秒级时间戳，固定排序所依据的 mtime。
 * @param path 文件路径。
 * @param seconds 秒级时间戳。
 */
function setMtime(path: string, seconds: number): void {
  utimesSync(path, seconds, seconds);
}

/**
 * 存入一张图并断言为新增，返回写入的文件名。
 * @param directory 图库目录。
 * @param bytes 图片字节。
 * @returns 新增文件名。
 */
async function storeNew(directory: string, bytes: Uint8Array): Promise<string> {
  const result: StoreRandomImageResult = await storeRandomImage(directory, bytes);
  if (result.status !== "stored") throw new Error(`expected stored, got ${result.status}`);
  return result.fileName;
}

describe("双缓存（字典序升序 vs 修改时间降序）与同步维护", () => {
  test("启动加载与懒加载：字典序缓存按文件名升序，图库缓存按修改时间降序、同修改时间按文件名升序", async () => {
    const root: string = temporaryRoot();
    const nameA: string = `${"a".repeat(64)}.png`;
    const nameB: string = `${"b".repeat(64)}.png`;
    const nameC: string = `${"c".repeat(64)}.png`;
    const nameD: string = `${"d".repeat(64)}.png`;
    for (const name of [nameA, nameB, nameC, nameD]) await Bun.write(join(root, name), "x");
    setMtime(join(root, nameC), 1_000);
    setMtime(join(root, nameA), 2_000);
    setMtime(join(root, nameD), 2_000);
    setMtime(join(root, nameB), 3_000);
    const expected: readonly string[] = [nameB, nameA, nameD, nameC];

    await ensureRandomImageDirectory(root);
    expect(randomImageDirectoryCache.current?.names).toEqual([nameA, nameB, nameC, nameD]);
    expect(galleryCacheNames()).toEqual([...expected]);
    expect((await listRandomImageGalleryEntries(root))?.map((entry): string => entry.fileName)).toEqual([...expected]);

    randomImageGalleryCache.current = null;
    expect((await listRandomImageGalleryEntries(root))?.map((entry): string => entry.fileName)).toEqual([...expected]);
  });

  test("storeRandomImage 新增时两边按各自顺序插入，重复入库不改变图库缓存位置", async () => {
    const root: string = temporaryRoot();
    await ensureRandomImageDirectory(root);
    expect(randomImageDirectoryCache.current?.names).toEqual([]);
    expect(galleryCacheNames()).toEqual([]);

    const first: string = await storeNew(root, PNG);
    const second: string = await storeNew(root, JPEG);
    expect(randomImageDirectoryCache.current?.names).toEqual([first, second].sort());
    // 后入库的修改时间不早于先入库的，且同修改时间时新写入项排在前面
    expect(galleryCacheNames()).toEqual([second, first]);

    expect(await storeRandomImage(root, PNG)).toEqual({ status: "existing", fileName: first });
    expect(galleryCacheNames()).toEqual([second, first]);
  });

  test("existing 路径按真实修改时间补入缓存外的已有文件，同修改时间时排在已有项之前", async () => {
    const root: string = temporaryRoot();
    await ensureRandomImageDirectory(root);
    const png: string = await storeNew(root, PNG);
    const jpeg: string = await storeNew(root, JPEG);

    setMtime(join(root, jpeg), 2_000);
    setMtime(join(root, png), 1_000);
    await ensureRandomImageDirectory(root);
    expect(galleryCacheNames()).toEqual([jpeg, png]);
    randomImageGalleryCache.current!.entries.splice(0, 1);
    await storeRandomImage(root, JPEG);
    expect(galleryCacheNames()).toEqual([jpeg, png]);

    setMtime(join(root, jpeg), 1_000);
    await ensureRandomImageDirectory(root);
    const [earlierName, laterName]: string[] = [png, jpeg].sort();
    expect(galleryCacheNames()).toEqual([earlierName!, laterName!]);
    randomImageGalleryCache.current!.entries.splice(1, 1);
    await storeRandomImage(root, laterName === png ? PNG : JPEG);
    expect(galleryCacheNames()).toEqual([laterName!, earlierName!]);
  });

  test("statRandomImageFile、deleteRandomImageFile 与 pickRandomImage 探测到文件消失或删除时同步剔除两边缓存", async () => {
    const root: string = temporaryRoot();
    await ensureRandomImageDirectory(root);
    const png: string = await storeNew(root, PNG);
    const jpeg: string = await storeNew(root, JPEG);

    await Bun.file(join(root, png)).delete();
    expect(await statRandomImageFile(root, png)).toBeNull();
    expect(randomImageDirectoryCache.current?.names).toEqual([jpeg]);
    expect(galleryCacheNames()).toEqual([jpeg]);

    expect(await deleteRandomImageFile(root, jpeg)).toBe(true);
    expect(randomImageDirectoryCache.current?.names).toEqual([]);
    expect(galleryCacheNames()).toEqual([]);

    const again: string = await storeNew(root, PNG);
    await Bun.file(join(root, again)).delete();
    expect(await pickRandomImage(root)).toEqual({ status: "empty" });
    expect(randomImageDirectoryCache.current?.names).toEqual([]);
    expect(galleryCacheNames()).toEqual([]);
  });

  test("目录被删除后 isRandomImageDirectory 将两边缓存置回 null", async () => {
    const root: string = temporaryRoot();
    await ensureRandomImageDirectory(root);
    await storeNew(root, JPEG);
    rmSync(root, { recursive: true, force: true });
    expect(await isRandomImageDirectory(root)).toBe(false);
    expect(randomImageDirectoryCache.current).toBeNull();
    expect(randomImageGalleryCache.current).toBeNull();
  });

  test("目标被替换为符号链接时 storeRandomImage 从两边缓存剔除；图库缓存为 null 时只维护字典序缓存", async () => {
    const root: string = temporaryRoot();
    await ensureRandomImageDirectory(root);
    const png: string = await storeNew(root, PNG);
    const jpeg: string = await storeNew(root, JPEG);
    const externalFile: string = join(temporaryRoot(), "ext.jpg");
    await Bun.write(externalFile, JPEG);
    await Bun.file(join(root, jpeg)).delete();
    symlinkSync(externalFile, join(root, jpeg));

    await storeRandomImage(root, JPEG);
    expect(randomImageDirectoryCache.current?.names).toEqual([png]);
    expect(galleryCacheNames()).toEqual([png]);

    randomImageGalleryCache.current = null;
    await storeRandomImage(root, JPEG);
    expect(randomImageDirectoryCache.current?.names).toEqual([png]);
    expect(randomImageGalleryCache.current).toBeNull();
  });
});
