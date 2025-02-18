import * as os from "os";
import * as utils from "./utils/actionUtils";
import * as cacheUtils from "@actions/cache/lib/internal/cacheUtils";
import * as tar from "@actions/cache/lib/internal/tar";
import * as core from "@actions/core";
import fsSync from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import * as exec from "@actions/exec";
import * as cache from "@actions/cache";
import { ValidationError } from "@actions/cache";
import { DownloadOptions, UploadOptions } from "@actions/cache/lib/options";
import { Inputs } from "./constants";

/**
 * 로컬 캐시 파일 이름을 생성합니다.
 * key와 버전, 압축 방식에 따라 파일 이름을 구성합니다.
 */
function getLocalCacheFileName(
    key: string,
    version: string,
    compressionMethod: string
): string {
    // 압축 방식에 따라 확장자 결정 (기본적으로 tar.gz, zstd 등 필요 시 수정)
    const extension = compressionMethod === "zstd" ? "tar.zst" : "tar.gz";
    // key에 파일명으로 사용하기 어려운 문자가 있을 수 있으므로 sanitize
    const sanitizedKey = key.replace(/[^a-zA-Z0-9-_]/g, "_");
    return `${sanitizedKey}-${version}.${extension}`;
}

/**
 * 경로 배열이 올바른지 검증합니다.
 */
function checkPaths(paths: string[]): void {
    if (!paths || paths.length === 0) {
        throw new Error(
            "Path Validation Error: At least one directory or file path is required"
        );
    }
}

/**
 * key에 대한 기본 검증 (최대 길이, 콤마 포함 여부 등)
 */
function checkKey(key: string): void {
    if (key.length > 512) {
        throw new Error(
            `Key Validation Error: ${key} cannot be larger than 512 characters.`
        );
    }
    const regex = /^[^,]*$/;
    if (!regex.test(key)) {
        throw new Error(`Key Validation Error: ${key} cannot contain commas.`);
    }
}

/**
 * 지정된 디렉토리(cacheDir)의 소유권을 현재 사용자로 변경하는 메서드.
 * exec 결과를 기반으로 warning 로그를 출력합니다.
 *
 * @param directory 소유권을 변경할 대상 디렉토리 경로
 */
async function grantPermission(directory: string): Promise<void> {
    const currentUser = os.userInfo().username;
    core.debug(`Changing ownership of ${directory} to ${currentUser}`);

    const exitCode: number = await exec.exec(
        "sudo",
        ["chown", "-R", `${currentUser}:${currentUser}`, directory],
        { ignoreReturnCode: true }
    );

    if (exitCode !== 0) {
        throw new Error(
            `Changing ownership of ${directory} exited with code ${exitCode}`
        );
    }
}

/**
 * restoreCache
 *
 * 로컬 캐시에서 저장된 tar 아카이브를 복원합니다.
 *
 * @param paths - 복원할 파일/디렉토리 목록
 * @param primaryKey - 복원 시 우선 검색할 키
 * @param restoreKeys - primaryKey 외에 검색할 후보 키들
 * @param options - 추가 옵션 (lookupOnly 등)
 * @param enableCrossOsArchive - 다른 OS에서 생성된 캐시도 복원할지 여부
 * @param cacheDir - 로컬 캐시 파일이 저장된 디렉토리 (미지정 시 cwd/.cache 사용)
 *
 * @returns 캐시 hit된 키 (복원 성공 시) 또는 undefined
 */
export async function restoreCache(
    paths: string[],
    primaryKey: string,
    restoreKeys: string[] = [],
    options?: DownloadOptions,
    enableCrossOsArchive?: boolean,
    cacheDir?: string | undefined
): Promise<string | undefined> {
    if (!cacheDir) {
        core.info("Cache with github cache");
        return await cache.restoreCache(
            paths,
            primaryKey,
            restoreKeys,
            { lookupOnly: options?.lookupOnly },
            enableCrossOsArchive
        );
    }

    core.info("Cache with local");
    try {
        await grantPermission(cacheDir);
        checkPaths(paths);

        // 전체 후보 키: primaryKey + restoreKeys
        const candidateKeys = [primaryKey, ...restoreKeys];
        core.debug(`Resolved Keys: ${JSON.stringify(candidateKeys)}`);
        if (candidateKeys.length > 10) {
            throw new ValidationError(
                "Key Validation Error: Keys are limited to a maximum of 10."
            );
        }
        candidateKeys.forEach(key => checkKey(key));

        // 압축 방식 및 캐시 버전 결정
        const compressionMethod = await cacheUtils.getCompressionMethod();
        const version = cacheUtils.getCacheVersion(
            paths,
            compressionMethod,
            enableCrossOsArchive
        );

        // 로컬 캐시 디렉토리 결정 (cacheDir 미지정 시 cwd/.cache 사용)
        await fs.mkdir(cacheDir, { recursive: true });

        // 후보 키 순서대로 로컬 캐시 파일이 존재하는지 확인
        for (const key of candidateKeys) {
            const cacheFileName = getLocalCacheFileName(
                key,
                version,
                compressionMethod
            );
            const archivePath = path.join(cacheDir, cacheFileName);
            core.debug(`Checking for cache file: ${archivePath}`);
            if (fsSync.existsSync(archivePath)) {
                core.info(`Cache hit for key: ${key}`);
                if (options?.lookupOnly) {
                    core.info("Lookup only - skipping extraction");
                    return key;
                }
                // 압축 해제 (기본적으로 현재 작업 디렉토리로 복원)
                await tar.extractTar(archivePath, compressionMethod);
                core.info("Cache restored successfully");
                return key;
            }
        }
    } catch (error: any) {
        core.warning(`Failed to restore cache: ${error.message}`);
    }
    return undefined;
}

/**
 * saveCache
 *
 * 주어진 파일/디렉토리들을 tar 아카이브로 묶어 로컬 캐시 디렉토리에 저장합니다.
 *
 * @param paths - 캐시할 파일/디렉토리 목록
 * @param key - 캐시를 식별할 키
 * @param options - 추가 옵션 (예: uploadChunkSize, lookupOnly 등)
 * @param enableCrossOsArchive - 다른 OS에서도 복원이 가능하도록 할지 여부
 * @param cacheDir - 캐시 파일을 저장할 로컬 디렉토리 (미지정 시 cwd/.cache 사용)
 *
 * @returns 저장된 캐시의 식별 번호 (여기서는 단순히 타임스탬프 기반의 번호 사용)
 */
export async function saveCache(
    paths: string[],
    key: string,
    options?: UploadOptions,
    enableCrossOsArchive?: boolean,
    cacheDir?: string
): Promise<number> {
    if (!cacheDir) {
        core.info("Cache with github cache");
        return await cache.saveCache(
            paths,
            key,
            { uploadChunkSize: utils.getInputAsInt(Inputs.UploadChunkSize) },
            enableCrossOsArchive
        );
    }

    core.info("Cache with local");
    let tempArchivePath = "";
    try {
        await grantPermission(cacheDir);
        checkPaths(paths);
        checkKey(key);

        const compressionMethod = await cacheUtils.getCompressionMethod();
        const cachePaths = await cacheUtils.resolvePaths(paths);
        core.debug(`Cache Paths: ${JSON.stringify(cachePaths)}`);
        if (cachePaths.length === 0) {
            throw new ValidationError(
                "Path Validation Error: Path(s) specified in the action for caching do(es) not exist, hence no cache is being saved."
            );
        }

        const version = cacheUtils.getCacheVersion(
            paths,
            compressionMethod,
            enableCrossOsArchive
        );

        // 로컬 캐시 디렉토리 결정 (미지정 시 cwd/.cache 사용)
        await fs.mkdir(cacheDir, { recursive: true });

        // 임시 디렉토리 내에 tar 아카이브 생성
        const tempDir = await cacheUtils.createTempDirectory();
        tempArchivePath = path.join(
            tempDir,
            cacheUtils.getCacheFileName(compressionMethod)
        );
        core.debug(`Archive Path: ${tempArchivePath}`);

        await tar.createTar(tempDir, cachePaths, compressionMethod);
        if (core.isDebug()) {
            await tar.listTar(tempArchivePath, compressionMethod);
        }

        const archiveFileSize =
            cacheUtils.getArchiveFileSizeInBytes(tempArchivePath);
        core.info(
            `Cache Archive Size: ~${Math.round(
                archiveFileSize / (1024 * 1024)
            )} MB (${archiveFileSize} B)`
        );

        // 옵션에 아카이브 크기 설정 (진행률 표시 등에 사용 가능)
        if (options) {
            options.archiveSizeBytes = archiveFileSize;
        }

        // 로컬 캐시 파일의 최종 경로 (key와 version에 따라 이름 부여)
        const destFileName = getLocalCacheFileName(
            key,
            version,
            compressionMethod
        );
        const destPath = path.join(cacheDir, destFileName);
        core.debug(`Saving cache to: ${destPath}`);

        // tempArchivePath의 파일을 로컬 캐시 디렉토리로 복사
        await fs.copyFile(tempArchivePath, destPath);
        core.info(`Cache saved successfully: ${destFileName}`);

        // 캐시 ID는 여기서는 간단히 현재 타임스탬프를 숫자로 사용합니다.
        return Date.now();
    } catch (error: any) {
        core.warning(`Failed to save cache: ${error.message}`);
        return -1;
    } finally {
        // 임시 아카이브 파일 삭제 (존재하면)
        if (tempArchivePath) {
            try {
                await cacheUtils.unlinkFile(tempArchivePath);
            } catch (error) {
                core.debug(`Failed to delete temporary archive: ${error}`);
            }
        }
    }
}
