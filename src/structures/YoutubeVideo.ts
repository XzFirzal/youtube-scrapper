import axios from "axios"
import Miniget from "miniget"
import m3u8stream from "m3u8stream"
import querystring from "querystring"
import { Util } from "../util/Util"
import { PassThrough } from "stream"
import { cachedTokens } from "../util/cache"
import { download } from "../functions/download"
import { extractTokens } from "../util/decipher"

export interface YoutubeVideoDetails {
    url: string
    id: string
    title: string
    duration: number
    keywords: string[]
    channelId: string
    isOwnerViewing: boolean
    shortDescription: string
    isCrawlable: boolean
    thumbnails: {
        url: string
        height: string
        width: string
    }[]
    averageRating: number
    allowRatings: boolean
    viewCount: number
    author: string
    isPrivate: boolean
    isUnpluggedCorpus: boolean
    isLiveContent: boolean
}

export interface YoutubeVideoFormat {
    itag: number
    mimeType: string
    codec: string
    type: string
    bitrate: number | null
    width?: number
    height?: number
    initRange?: {
        start: number
        end: number
    }
    indexRange?: {
        start: number
        end: number
    }
    lastModifiedTimestamp?: number
    contentLength?: number
    quality?: string
    audioChannels?: number
    audioSampleRate?: number
    loudnessDb?: number
    s?: string
    sp?: string
    url: string
    fps?: number
    qualityLabel: string | null
    projectionType?: "RECTANGULAR",
    averageBitrate?: number
    approxDurationMs?: number
    signatureCipher?: string
    getDecodedCipher?: () => string | undefined

    /* Provided by itag format. */
    audioBitrate?: number | null

    /* These come from metadata and not by youtube. */
    hasAudio?: boolean
    hasVideo?: boolean
    isLive?: boolean
    isHLS?: boolean
    isDashMPD?: boolean
}

export interface DownloadOptions {
    chunkMode?: {
        chunkSize?: number
    }
    highWaterMark?: number
    resource?: PassThrough,
    begin?: number | string
    pipe?: boolean
}

export class YoutubeVideo {
    private json: any

    moreFormats?: YoutubeVideoFormat[]
    html5Player?: string
    tokens?: string[]

    constructor(json: any) {
        this.json = json
    }

    get formats(): YoutubeVideoFormat[] {
        const arr = this.moreFormats ?? []

        for (const format of 
            [].concat(
                this.json.streamingData?.adaptiveFormats ?? [],
                this.json.streamingData?.formats ?? []
            ) as any[]) {
            
            let frmt: YoutubeVideoFormat = {
                itag: format.itag, 
                mimeType: format.mimeType,
                type: format.mimeType.split(";")[0],
                codec: format.mimeType.split('"')[1].split('"')[0],
                bitrate: format.bitrate,
                width: format.width,
                height: format.height,
                initRange: {
                    start: Number(format.initRange?.start),
                    end: Number(format.initRange?.end)
                },
                indexRange: {
                    start: Number(format.indexRange?.start),
                    end: Number(format.indexRange?.end)
                },
                lastModifiedTimestamp: Number(format.lastModified),
                contentLength: Number(format.contentLength),
                fps: format.fps, 
                quality: format.quality,
                url: format.url, 
                qualityLabel: format.qualityLabel,
                projectionType: format.projectionType,
                averageBitrate: format.averageBitrate,
                approxDurationMs: Number(format.approxDurationMs),
                signatureCipher: format.signatureCipher ?? format.cipher,
                getDecodedCipher: () => decodeURIComponent(format.signatureCipher),
            }

            if (format.url && !frmt.signatureCipher) {
                frmt.url = format.url 
            }

            if (!frmt.url) {
                frmt = Object.assign(frmt, querystring.parse(frmt.signatureCipher as string))
            }

            let sig = this.tokens && frmt.s ? YoutubeVideo.decipher(this.tokens, frmt.s) : undefined

            const url = new URL(decodeURIComponent(frmt.url as string))

            url.searchParams.set("ratebypass", "yes")

            if (sig) {
                url.searchParams.set(frmt.sp ?? "signature", sig)
            }
            
            frmt.url = url.toString()

            arr.push(
                Util.addMetadataToFormat(frmt)
            )
        }

        return arr
    }

    download(format: YoutubeVideoFormat, options: DownloadOptions = {}) {
        if (format.isHLS || format.isDashMPD) {
            return m3u8stream(format.url as string, {
                id: String(format.itag),
                parser: format.isDashMPD ? "dash-mpd" : "m3u8",
                highWaterMark: options.highWaterMark ?? 64 * 1024,
                begin: options.begin ?? (format.isLive ? Date.now() : 0),
                requestOptions: {
                    maxReconnects: Infinity,
                    maxRetries: 10,
                    backoff: { inc: 20, max: 100 }
                }
            })
        } else {
            if (options.chunkMode) {
                const stream = options.resource ?? new PassThrough({
                    // Set watermark to 64KB (default) for chunking.
                    highWaterMark: options.highWaterMark ?? 64 * 1024
                }) 
    
                let downloadChunkSize = options.chunkMode.chunkSize ?? 256 * 1024
    
                let endBytes = downloadChunkSize, startBytes = 0

                const pipelike = options.pipe ?? true
                
                let awaitDrain: (() => void) | null

                if (pipelike) {
                    stream.on("drain", () => {
                        awaitDrain?.()
                        awaitDrain = null
                    })
                }
                
                const getNextChunk = () => {
                    if (endBytes > (format.contentLength as number)) {
                        endBytes = format.contentLength as number
                    }
                    const request = Miniget(format.url as string, {
                        headers: {
                            Range: `bytes=${startBytes}-${endBytes}`
                        }
                    })

                    // Handle unknown 403 errors accordinly.
                    request.once("error", error => {
                        try { request.destroy() } catch { }
                        if (error.message.includes("403")) {
                            request.removeAllListeners()
                            options.resource = stream
                            download(this.details.url)
                        } else {
                            throw error
                        }
                    })
    
                    request.on("data", (chunk: Buffer) => {
                        if (stream.destroyed) {
                            request.destroy()
                            return;
                        }
                        startBytes += chunk.length
                        
                        if (pipelike) {
                            if (!stream.write(chunk)) {
                                request.pause()
                                awaitDrain = () => request.resume()
                            }
                        } else {
                            stream.write(chunk)
                        }
                    })
    
                    request.once("end", () => {
                        if (stream.destroyed) return;
                        if (endBytes === format.contentLength) {
                            return;
                        }
                        endBytes = startBytes + downloadChunkSize
                        getNextChunk() 
                    })
                }
    
                getNextChunk()
    
                return stream
            } else {
                const stream = new PassThrough({ highWaterMark: format.contentLength })

                const request = Miniget(format.url as string) 

                request.once("error", error => {
                    if (error.message.includes("403")) {
                        request.removeAllListeners()
                        options.resource = stream
                        download(this.details.url)
                    } else {
                        throw error
                    }
                    request.destroy()
                })

                request.once("end", request.destroy)
                stream.once("end", stream.destroy)

                request.pipe(stream)

                return stream
            }
        }
    }

    static decipher(tokens: string[], sig: string): string {
        let arr = sig.split("")

        for (let i = 0;i < tokens.length;i++) {
            const token = tokens[i]
            let position; 

            switch(token[0]) {
                case 'r': 
                    arr = arr.reverse()
                    break
                case 'w':
                    position = ~~token.slice(1)
                    arr = Util.swapSignatureArray(arr, position)
                    break
                case 's':
                    position = ~~token.slice(1);
                    arr = arr.slice(position);
                    break
                case 'p':
                    position = ~~token.slice(1);
                    arr.splice(0, position);
                    break
            }
        }

        return arr.join('')
    }

    get info(): YoutubeVideoDetails & { formats: YoutubeVideoFormat[] } {
        const details = this.details

        const formats = this.formats

        return Object.assign(details, { formats: formats })
    }

    getHtml5Player(body: string): string {
        const playerURL = body.split(`"jsUrl":"`)[1]?.split('"')[0]

        this.html5Player = `${Util.getBaseYTURL()}${playerURL}`

        return this.html5Player
    }

    async fetchTokens() {
        if (cachedTokens.has(this.html5Player as string) || this.tokens) {
            return cachedTokens.get(this.html5Player) ?? this.tokens
        }

        const request = await axios.get<string>(this.html5Player as string)

        const tokens = extractTokens(request.data)

        cachedTokens.set(this.html5Player as string, tokens)

        this.tokens = tokens as string[]

        return tokens
    }

    get details(): YoutubeVideoDetails {
        return {
            url: `${Util.getYTVideoURL()}${this.json.videoDetails.videoId}`,
            id: this.json.videoDetails.videoId,
            title: this.json.videoDetails.title, 
            duration: Number(this.json.videoDetails.lengthSeconds) * 1000,
            channelId: this.json.videoDetails.channelId,
            keywords: this.json.videoDetails.keywords,
            isOwnerViewing: this.json.videoDetails.isOwnerViewing,
            shortDescription: this.json.videoDetails.shortDescription,
            isCrawlable: this.json.videoDetails.isCrawlable,
            thumbnails: this.json.videoDetails.thumbnail.thumbnails,
            averageRating: this.json.videoDetails.averageRating,
            allowRatings: this.json.videoDetails.allowRatings,
            viewCount: Number(this.json.videoDetails.viewCount),
            isPrivate: this.json.videoDetails.isPrivate,
            author: this.json.videoDetails.author,
            isUnpluggedCorpus: this.json.videoDetails.isUnpluggedCorpus,
            isLiveContent: this.json.videoDetails.isLiveContent
        }
    }
}