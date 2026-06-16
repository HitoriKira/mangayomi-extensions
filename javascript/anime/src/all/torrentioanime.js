const mangayomiSources = [{
    "name": "Torrentio Anime (Debrid & Torrent)",
    "lang": "all",
    "baseUrl": "https://torrentio.strem.fun",
    "apiUrl": "",
    "iconUrl": "https://raw.githubusercontent.com/m2k3a/mangayomi-extensions/main/javascript/icon/all.torrentio.png",
    "typeSource": "torrent", // Leave as torrent, but Debrid links will stream standard HTTP URLs natively
    "isManga": false,
    "itemType": 1,
    "version": "0.0.4", // Incremented to notice updates safely
    "pkgPath": "anime/src/all/torrentioanime.js"
}];

class DefaultExtension extends MProvider {
    constructor() {
        super();
        this.client = new Client();
    }

    anilistQuery() {
        return `
            query ($page: Int, $perPage: Int, $sort: [MediaSort], $search: String) {
                Page(page: $page, perPage: $perPage) {
                    pageInfo {
                        currentPage
                        hasNextPage
                    }
                    media(type: ANIME, sort: $sort, search: $search, status_in: [RELEASING, FINISHED, NOT_YET_RELEASED]) {
                        id
                        title {
                            romaji
                            english
                            native
                        }
                        coverImage {
                            extraLarge
                            large
                        }
                        description
                        status
                        tags {
                            name
                        }
                        genres
                        studios {
                            nodes {
                                name
                            }
                        }
                        countryOfOrigin
                        isAdult
                    }
                }
            }
        `.trim();
    }
    anilistLatestQuery() {
        const currentTimeInSeconds = Math.floor(Date.now() / 1000);
        return `
            query ($page: Int, $perPage: Int, $sort: [AiringSort]) {
              Page(page: $page, perPage: $perPage) {
                pageInfo {
                  currentPage
                  hasNextPage
                }
                airingSchedules(
                  airingAt_greater: 0
                  airingAt_lesser: ${currentTimeInSeconds - 10000}
                  sort: $sort
                ) {
                  media {
                    id
                    title {
                      romaji
                      english
                      native
                    }
                    coverImage {
                      extraLarge
                      large
                    }
                    description
                    status
                    tags {
                      name
                    }
                    genres
                    studios {
                      nodes {
                        name
                      }
                    }
                    countryOfOrigin
                    isAdult
                  }
                }
              }
            }
        `.trim();
    }
    async makeGraphQLRequest(query, variables) {
        const res = await this.client.post("https://graphql.anilist.co", {},
            {
                query, variables
            });
        return res;
    }
    parseSearchJson(jsonLine, isLatestQuery = false) {
        const jsonData = JSON.parse(jsonLine);
        jsonData.type = isLatestQuery ? "AnilistMetaLatest" : "AnilistMeta";
        const metaData = jsonData;

        const mediaList = metaData.type == "AnilistMeta"
            ? metaData.data?.Page?.media || []
            : metaData.data?.Page?.airingSchedules.map(schedule => schedule.media) || [];

        const hasNextPage = metaData.type == "AnilistMeta" || metaData.type == "AnilistMetaLatest"
            ? metaData.data?.Page?.pageInfo?.hasNextPage || false
            : false;

        const animeList = mediaList
            .filter(media => !((media?.countryOfOrigin === "CN" || media?.isAdult) && isLatestQuery))
            .map(media => {
                const anime = {};
                anime.link = media?.id?.toString() || "";
                anime.name = (() => {
                    const preferenceTitle = new SharedPreferences().get("pref_title")
                    switch (preferenceTitle) {
                        case "romaji":
                            return media?.title?.romaji || "";
                        case "english":
                            return media?.title?.english?.trim() || media?.title?.romaji || "";
                        case "native":
                            return media?.title?.native || "";
                        default:
                            return "";
                    }
                })();
                anime.imageUrl = media?.coverImage?.extraLarge || "";

                return anime;
            });

        return { "list": animeList, "hasNextPage": hasNextPage };
    }
    async getPopular(page) {
        const variables = JSON.stringify({
            page: page,
            perPage: 30,
            sort: "TRENDING_DESC"
        });

        const res = await this.makeGraphQLRequest(this.anilistQuery(), variables);

        return this.parseSearchJson(res.body)
    }
    async getLatestUpdates(page) {
        const variables = JSON.stringify({
            page: page,
            perPage: 30,
            sort: "TIME_DESC"
        });

        const res = await this.makeGraphQLRequest(this.anilistLatestQuery(), variables);

        return this.parseSearchJson(res.body, true)
    }
    async search(query, page, filters) {
        const variables = JSON.stringify({
            page: page,
            perPage: 30,
            sort: "POPULARITY_DESC",
            search: query
        });

        const res = await this.makeGraphQLRequest(this.anilistQuery(), variables);

        return this.parseSearchJson(res.body)
    }
    async getDetail(url) {
    const query = `
        query($id: Int){
            Media(id: $id){
                id
                title {
                    romaji
                    english
                    native
                }
                coverImage {
                    extraLarge
                    large
                }
                description
                status
                tags {
                    name
                }
                genres
                studios {
                    nodes {
                        name
                    }
                }
                countryOfOrigin
                isAdult
            }
        }
    `.trim();

    const variables = JSON.stringify({ id: url });

    const res = await this.makeGraphQLRequest(query, variables);
    const media = JSON.parse(res.body).data.Media;
    const anime = {};
    anime.imageUrl = media?.coverImage?.extraLarge || "";
    anime.description = (media?.description || "No Description")
        .replace(/<br><br>/g, "\n")
        .replace(/<.*?>/g, "");

    anime.status = (() => {
        switch (media?.status) {
            case "RELEASING":
                return 0;
            case "FINISHED":
                return 1;
            case "HIATUS":
                return 2;
            case "NOT_YET_RELEASED":
                return 3;
            default:
                return 5;
        }
    })();

    const tagsList = media?.tags?.map(tag => tag.name).filter(Boolean) || [];
    const genresList = media?.genres || [];
    anime.genre = [...new Set([...tagsList, ...genresList])].sort();
    
    const studiosList = media?.studios?.nodes?.map(node => node.name).filter(Boolean) || [];
    anime.author = studiosList.sort().join(", ");

    // Fetch initial mappings
    const response = await this.client.get(`https://api.ani.zip/mappings?anilist_id=${url}`);
    const aniZipData = JSON.parse(response.body);
    const kitsuId = aniZipData.mappings?.kitsu_id?.toString() || "";

    let targetKitsuId = kitsuId;
    let absoluteOffset = 0;

    // Split-cour automation engine
    const aniZipEpisodes = aniZipData.episodes || {};
    const firstEpKey = Object.keys(aniZipEpisodes)[0];
    if (firstEpKey) {
        const firstEp = aniZipEpisodes[firstEpKey];
        const relNum = parseInt(firstEp.episode);
        const absNum = parseInt(firstEp.absoluteEpisodeNumber);
        
        // If absolute number is greater than relative number, we are in a Part 2 / split cour
        if (!isNaN(relNum) && !isNaN(absNum) && absNum > relNum) {
            absoluteOffset = absNum - relNum;
            
            // Query Kitsu to find the prequel ID (Main Season / Part 1)
            try {
                const relationRes = await this.client.get(`https://kitsu.io/api/edge/anime/${kitsuId}/media-relationships?include=destination`);
                const relationData = JSON.parse(relationRes.body);
                const prequel = relationData.data?.find(r => r.attributes?.role === "prequel");
                if (prequel?.relationships?.destination?.data?.id) {
                    targetKitsuId = prequel.relationships.destination.data.id.toString();
                }
            } catch (e) {
                // Fail-safe fallback to current ID if Kitsu API faces issues
                targetKitsuId = kitsuId;
            }
        }
    }

    const responseEpisodes = await this.client.get(`https://anime-kitsu.strem.fun/meta/series/kitsu%3A${kitsuId}.json`);
    const episodeList = JSON.parse(responseEpisodes.body);
    
    anime.episodes = (() => {
        switch (episodeList.meta?.type) {
            case "series": {
                const videos = episodeList.meta.videos || [];
                return videos
                    .filter(video => video.thumbnail !== null && ((video.released ? new Date(video.released) : Date.now()) < Date.now()))
                    .map(video => {
                        const releaseDate = video.released ? new Date(video.released) : Date.now();
                        
                        // Recalculate stream URL parameters if an offset exists
                        const currentEpNum = parseInt(video.episode);
                        const targetUrl = absoluteOffset > 0 
                            ? `/stream/series/kitsu:${targetKitsuId}:${currentEpNum + absoluteOffset}.json`
                            : `/stream/series/${video.id}.json`;

                        return {
                            url: targetUrl,
                            dateUpload: releaseDate.valueOf().toString(),
                            name: `Episode ${video.episode} : ${video.title
                                ?.replace(/^Episode /, "")
                                ?.replace(/^\d+\s*/, "")
                                ?.trim()}`,
                        };
                    })
                    .reverse();
            }

            case "movie": {
                const kitsuMovieId = episodeList.meta.kitsuId;
                return [
                    {
                        url: `/stream/movie/${kitsuMovieId}.json`,
                        name: "Movie",
                    },
                ].reverse();
            }

            default:
                return [];
        }
    })();

    return anime;
}

appendQueryParam(key, values) {
    let url = "";
    if (values && values.length > 0) {
        const filteredValues = Array.from(values).filter(value => value.trim() !== "").join(",");
        url += `${key}=${filteredValues}|`;
    }
    return url;
}

    async getVideoList(url) {
        const preferences = new SharedPreferences();

        let mainURL = `${this.source.baseUrl}/`;
        
        // 1. Compile configurations filters
        let configParams = "";
        configParams += this.appendQueryParam("providers", preferences.get("provider_selection"));
        configParams += this.appendQueryParam("language", preferences.get("lang_selection"));
        configParams += this.appendQueryParam("qualityfilter", preferences.get("quality_selection"));
        configParams += this.appendQueryParam("sort", new Set([preferences.get("sorting_link")]));
        
        // Clean trailing configuration pipes
        configParams = configParams.replace(/\|$/, "");

        // 2. Compile Debrid Parameter String if chosen
        const debridService = preferences.get("debrid_service");
        const debridToken = preferences.get("debrid_token").trim();
        
        let debridParam = "";
        if (debridService !== "none" && debridToken !== "") {
            debridParam = `${debridService}=${debridToken}`;
        }

        // 3. Chain together properly formatted URL
        // Syntax needed: baseUrl / configParams / debridParam / url
        if (configParams && debridParam) {
            mainURL += `${configParams}|${debridParam}`;
        } else if (configParams) {
            mainURL += configParams;
        } else if (debridParam) {
            mainURL += debridParam;
        }

        // Append actual stream file tracking syntax
        mainURL += url;

        const responseEpisodes = await this.client.get(mainURL);
        const streamList = JSON.parse(responseEpisodes.body);
        
        const animeTrackers = [
            "http://nyaa.tracker.wf:7777/announce",
            "http://anidex.moe:6969/announce",
            "http://tracker.anirena.com:80/announce",
            "udp://tracker.uw0.xyz:6969/announce",
            "http://share.camoe.cn:8080/announce",
            "http://t.nyaatracker.com:80/announce",
            "udp://47.ip-51-68-199.eu:6969/announce",
            "udp://9.rarbg.me:2940",
            "udp://9.rarbg.to:2820",
            "udp://exodus.desync.com:6969/announce",
            "udp://explodie.org:6969/announce",
            "udp://ipv4.tracker.harry.lu:80/announce",
            "udp://open.stealth.si:80/announce",
            "udp://opentor.org:2710/announce",
            "udp://opentracker.i2p.rocks:6969/announce",
            "udp://retracker.lanta-net.ru:2710/announce",
            "udp://tracker.cyberia.is:6969/announce",
            "udp://tracker.dler.org:6969/announce",
            "udp://tracker.ds.is:6969/announce",
            "udp://tracker.internetwarriors.net:1337",
            "udp://tracker.openbittorrent.com:6969/announce",
            "udp://tracker.opentrackr.org:1337/announce",
            "udp://tracker.tiny-vps.com:6969/announce",
            "udp://tracker.torrent.eu.org:451/announce",
            "udp://valakas.rollo.dnsabr.com:2710/announce",
            "udp://www.torrent.eu.org:451/announce"
        ];

        const videos = this.sortVideos((streamList.streams || []).map(stream => {
            const videoTitle = `${(stream.name || "").replace("Torrentio\n", "")}\n${stream.title || ""}`.trim();
            
            // If Debrid is active, Torrentio parses a direct streaming HTTP link in stream.url
            // Otherwise it falls back to standard P2P torrent hash.
            let streamUrl = stream.url;
            if (!streamUrl) {
                streamUrl = `magnet:?xt=urn:btih:${stream.infoHash}&dn=${stream.infoHash}&tr=${animeTrackers.join("&tr=")}&index=${stream.fileIdx}`;
            }

            return {
                url: streamUrl,
                originalUrl: streamUrl,
                quality: videoTitle,
            };
        }));

        const numberOfLinks = preferences.get("number_of_links");
        if (numberOfLinks == "all") {
            return videos;
        }

        return videos.slice(0, parseInt(numberOfLinks))
    }

    sortVideos(videos) {
        const preferences = new SharedPreferences();

        const isDub = preferences.get("dubbed");
        const isEfficient = preferences.get("efficient");

        return videos.sort((a, b) => {
            const regexMatchA = /\[(.+?) download\]/.test(a.quality);
            const regexMatchB = /\[(.+?) download\]/.test(b.quality);

            const isDubA = isDub && !a.quality.toLowerCase().includes("dubbed");
            const isDubB = isDub && !b.quality.toLowerCase().includes("dubbed");

            const isEfficientA = isEfficient && !["hevc", "265", "av1"].some(q => a.quality.toLowerCase().includes(q));
            const isEfficientB = isEfficient && !["hevc", "265", "av1"].some(q => b.quality.toLowerCase().includes(q));

            return (
                regexMatchA - regexMatchB ||
                isDubA - isDubB ||
                isEfficientA - isEfficientB
            );
        });
    }

    getSourcePreferences() {
        return [
            {
                "key": "debrid_service",
                "listPreference": {
                    "title": "Debrid Service Providers",
                    "summary": "Choose your Premium Debrid Cloud system to stream instant cached video bypasses",
                    "valueIndex": 0,
                    "entries": [
                        "None (Pure P2P Torrenting)",
                        "Real-Debrid",
                        "Premiumize",
                        "AllDebrid",
                        "Debrid-Link",
                        "TorBox"
                    ],
                    "entryValues": [
                        "none",
                        "realdebrid",
                        "premiumize",
                        "alldebrid",
                        "debridlink",
                        "torbox"
                    ],
                }
            },
            {
                "key": "debrid_token",
                "editTextPreference": {
                    "title": "Debrid API Private Token / Key",
                    "summary": "Paste your private service account API credentials token here.",
                    "dialogTitle": "Debrid API Token Setting",
                    "dialogMessage": "Provide the authorization token key linked inside your chosen provider developer dashboard setups.",
                    "text": ""
                }
            },
            {
                "key": "number_of_links",
                "listPreference": {
                    "title": "Number of links to load for video list",
                    "summary": "⚠️ Increasing the number of links will increase the loading time of the video list",
                    "valueIndex": 1,
                    "entries": [
                        "2",
                        "4",
                        "8",
                        "12",
                        "all"],
                    "entryValues": [
                        "2",
                        "4",
                        "8",
                        "12",
                        "all"],
                }
            },
            {
                "key": "provider_selection",
                "multiSelectListPreference": {
                    "title": "Enable/Disable Providers",
                    "summary": "",
                    "entries": [
                        "YTS",
                        "EZTV",
                        "RARBG",
                        "1337x",
                        "ThePirateBay",
                        "KickassTorrents",
                        "TorrentGalaxy",
                        "MagnetDL",
                        "HorribleSubs",
                        "NyaaSi",
                        "TokyoTosho",
                        "AniDex",
                        "🇷🇺 Rutor",
                        "🇷🇺 Rutracker",
                        "🇵🇹 Comando",
                        "🇵🇹 BluDV",
                        "🇫🇷 Torrent9",
                        "🇪🇸 MejorTorrent",
                        "🇲🇽 Cinecalidad"],
                    "entryValues": [
                        "yts",
                        "eztv",
                        "rarbg",
                        "1337x",
                        "thepiratebay",
                        "kickasstorrents",
                        "torrentgalaxy",
                        "magnetdl",
                        "horriblesubs",
                        "nyaasi",
                        "tokyotosho",
                        "anidex",
                        "rutor",
                        "rutracker",
                        "comando",
                        "bludv",
                        "torrent9",
                        "mejortorrent",
                        "cinecalidad"],
                    "values": [
                        "nyaasi",]
                }
            },
            {
                "key": "quality_selection",
                "multiSelectListPreference": {
                    "title": "Exclude Qualities/Resolutions",
                    "summary": "",
                    "entries": [
                        "BluRay REMUX",
                        "HDR/HDR10+/Dolby Vision",
                        "Dolby Vision",
                        "4k",
                        "1080p",
                        "720p",
                        "480p",
                        "Other (DVDRip/HDRip/BDRip...)",
                        "Screener",
                        "Cam",
                        "Unknown"],
                    "entryValues": [
                        "brremux",
                        "hdrall",
                        "dolbyvision",
                        "4k",
                        "1080p",
                        "720p",
                        "480p",
                        "other",
                        "scr",
                        "cam",
                        "unknown"],
                    "values": [
                        "720p",
                        "480p",
                        "other",
                        "scr",
                        "cam",
                        "unknown"]
                }
            },
            {
                "key": "lang_selection",
                "multiSelectListPreference": {
                    "title": "Priority foreign language",
                    "summary": "",
                    "entries": [
                        "🇯🇵 Japanese",
                        "🇷🇺 Russian",
                        "🇮🇹 Italian",
                        "🇵🇹 Portuguese",
                        "🇪🇸 Spanish",
                        "🇲🇽 Latino",
                        "🇰🇷 Korean",
                        "🇨🇳 Chinese",
                        "🇹WAN Taiwanese",
                        "🇫🇷 French",
                        "🇩🇪 German",
                        "🇳🇱 Dutch",
                        "🇮🇳 Hindi",
                        "🇮🇳 Telugu",
                        "🇮🇳 Tamil",
                        "🇵🇱 Polish",
                        "🇱🇹 Lithuanian",
                        "🇱嫌 Latvian",
                        "🇪🇪 Estonian",
                        "🇨🇿 Czech",
                        "🇸婚 Slovakian",
                        "🇸🇮 Slovenian",
                        "🇭🇺 Hungarian",
                        "🇷🇴 Romanian",
                        "🇧🇬 Bulgarian",
                        "🇷🇸 Serbian",
                        "🇭🇷 Croatian",
                        "🇺🇦 Ukrainian",
                        "🇬🇷 Greek",
                        "🇩🇰 Danish",
                        "🇫🇮 Finnish",
                        "🇸🇪 Swedish",
                        "🇳🇴 Norwegian",
                        "🇹🇷 Turkish",
                        "🇸🇦 Arabic",
                        "🇮🇷 Persian",
                        "🇮🇱 Hebrew",
                        "🇻🇳 Vietnamese",
                        "🇮🇩 Indonesian",
                        "🇲🇾 Malay",
                        "🇹🇭 Thai",],
                    "entryValues": [
                        "japanese",
                        "russian",
                        "italian",
                        "portuguese",
                        "spanish",
                        "latino",
                        "korean",
                        "chinese",
                        "taiwanese",
                        "french",
                        "german",
                        "dutch",
                        "hindi",
                        "telugu",
                        "tamil",
                        "polish",
                        "lithuanian",
                        "latvian",
                        "estonian",
                        "czech",
                        "slovakian",
                        "slovenian",
                        "hungarian",
                        "romanian",
                        "bulgarian",
                        "serbian",
                        "croatian",
                        "ukrainian",
                        "greek",
                        "danish",
                        "finnish",
                        "swedish",
                        "norwegian",
                        "turkish",
                        "arabic",
                        "persian",
                        "hebrew",
                        "vietnamese",
                        "indonesian",
                        "malay",
                        "thai"],
                    "values": []
                }
            },
            {
                "key": "sorting_link",
                "listPreference": {
                    "title": "Sorting",
                    "summary": "",
                    "valueIndex": 0,
                    "entries": [
                        "By quality then seeders",
                        "By quality then size",
                        "By seeders",
                        "By size"],
                    "entryValues": [
                        "quality",
                        "qualitysize",
                        "seeders",
                        "size"],
                }
            },
            {
                "key": "pref_title",
                "listPreference": {
                    "title": "Preferred Title",
                    "summary": "",
                    "valueIndex": 0,
                    "entries": [
                        "Romaji",
                        "English",
                        "Native"],
                    "entryValues": [
                        "romaji",
                        "english",
                        "native"],
                }
            },
            {
                "key": "dubbed",
                "switchPreferenceCompat": {
                    "title": "Dubbed Video Priority",
                    "summary": "",
                    "value": false
                }
            },
            {
                "key": "efficient",
                "switchPreferenceCompat": {
                    "title": "Efficient Video Priority",
                    "summary": "Codec: (HEVC / x265) & AV1. High-quality video with less data usage.",
                    "value": false
                }
            }
        ];
    }
}
