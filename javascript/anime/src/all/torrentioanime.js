const mangayomiSources = [{
    "name": "Torrentio Anime (Debrid & Torrent)",
    "lang": "all",
    "baseUrl": "https://torrentio.strem.fun",
    "apiUrl": "",
    "iconUrl": "https://raw.githubusercontent.com/m2k3a/mangayomi-extensions/main/javascript/icon/all.torrentio.png",
    "typeSource": "torrent", 
    "isManga": false,
    "itemType": 1,
    "version": "0.0.5", 
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
        const res = await this.client.post("https://graphql.anilist.co", {}, { query, variables });
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
                season
                seasonYear
                format
                episodes
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

    const variables = JSON.stringify({ id: parseInt(url) || url });

    const res = await this.makeGraphQLRequest(query, variables);
    const media = JSON.parse(res.body).data.Media;
    const anime = {};

    const titleObj = media?.title;
    anime.title = titleObj?.english?.trim() || titleObj?.romaji || titleObj?.native || "";
    anime.imageUrl = media?.coverImage?.extraLarge || media?.coverImage?.large || "";

    let desc = media?.description || "No Description";
    desc = desc
        .replace(/<br>\n/g, "\n")
        .replace(/<br>/g, "\n")
        .replace(/<.*?>/g, "");

    let metaDetails = "";
    if (media?.season || media?.seasonYear) {
        metaDetails += `\n\nRelease: ${media.season || ""} ${media.seasonYear || ""}`.trimEnd();
    }
    if (media?.format) {
        metaDetails += `\nType: ${media.format}`;
    }
    if (media?.episodes) {
        metaDetails += `\nTotal Episode Count: ${media.episodes}`;
    }
    anime.description = (desc + metaDetails).trim();

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

    const response = await this.client.get(`https://api.ani.zip/mappings?anilist_id=${url}`);
    const aniZipData = JSON.parse(response.body);

    const mappings = aniZipData?.mappings || {};
    const type = mappings.type;
    const kitsuId = mappings.kitsu_id;
    const episodesMap = aniZipData?.episodes || {};

    // FIXED: Changed fallback from anime.name to anime.title
    const searchTitle = aniZipData?.title?.en || aniZipData?.title?.romaji || anime.title || "";

    anime.episodes = await (async () => {
        const totalEpisodes = Object.keys(episodesMap).length;

        // Shared safe sorting function to prevent NaN lookup failures
        const safeEpisodeSort = (arr) => {
            return arr.sort((a, b) => {
                const matchA = a.name.match(/\d+/);
                const matchB = b.name.match(/\d+/);
                const valA = matchA ? parseFloat(matchA[0]) : 0;
                const valB = matchB ? parseFloat(matchB[0]) : 0;
                return valA - valB;
            }).reverse();
        };

        switch (type) {
            case "TV":
            case "ONA":
            case "OVA": {
                const parsedEpisodes = [];

                for (const key in episodesMap) {
                    if (!episodesMap.hasOwnProperty(key)) continue;
                    const ep = episodesMap[key];
                    if (!ep) continue;

                    const epNum = parseFloat(ep.episode);
                    if (isNaN(epNum)) continue;

                    const airDateMs = ep.airDate ? new Date(ep.airDate).getTime() : 0;
                    if (airDateMs > Date.now()) continue; 
                    
                    const title = typeof ep.title === 'string' ? ep.title : (ep.title?.en || ep.title?.romaji || "");
                    const epName = title ? `Episode ${ep.episode}: ${title}` : `Episode ${ep.episode}`;

                    parsedEpisodes.push({
                        url: `/stream/series/kitsu:${kitsuId}:${epNum.toFixed(0)}.json`,
                        dateUpload: airDateMs.toString(),
                        name: epName,
                    });
                }
                return safeEpisodeSort(parsedEpisodes);
            }

            case "MOVIE": {
                    const kitsuId = episodeList.meta.kitsuId;

                    return [
                        {
                            url: `/stream/movie/${kitsuId}.json`,
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

    // FIXED: Standardized array-checks to handle both raw Arrays and Sets accurately
    appendQueryParam(key, values) {
        let url = "";
        if (values) {
            const valueArray = Array.from(values);
            if (valueArray.length > 0) {
                const filteredValues = valueArray.filter(value => value && value.trim() !== "").join(",");
                if (filteredValues) {
                    url += `${key}=${filteredValues}|`;
                }
            }
        }
        return url;
    };

    async getVideoList(url) {
    let targetUrl = url;
    try {
        const match = url.match(/\/stream\/series\/kitsu:(\d+):(\d+)\.json/);
        if (match) {
            const kitsuId = match[1];
            const epNum = parseInt(match[2]);

            // Strict Whitelist: Only run absolute calculation for these specific Kitsu IDs
            // 18343 = How a Realist Hero Rebuilt the Kingdom Part 2
            const absoluteNumberingWhitelist = ["45252"]; 

            if (absoluteNumberingWhitelist.includes(kitsuId)) {
                const relationRes = await this.client.get(`https://kitsu.io/api/edge/anime/${kitsuId}/media-relationships?include=destination`);
                
                if (relationRes && relationRes.body) {
                    const relationData = JSON.parse(relationRes.body);
                    const prequel = relationData.data?.find(r => r.attributes?.role === "prequel");
                    
                    if (prequel) {
                        const prequelId = prequel.relationships?.destination?.data?.id;
                        const includedDestination = relationData.included?.find(inc => inc.type === "anime" && inc.id === prequelId);
                        const prequelEpCount = parseInt(includedDestination?.attributes?.episodeCount);

                        if (prequelId && !isNaN(prequelEpCount) && prequelEpCount > 0 && includedDestination?.attributes?.subtype === "TV") {
                            const absoluteEp = epNum + prequelEpCount;
                            targetUrl = `/stream/series/kitsu:${prequelId}:${absoluteEp}.json`;
                        }
                    }
                }
            }
        }
    } catch (e) {
        console.error("Absolute calculation bypassed:", e);
        targetUrl = url; // Safe fallback path
    }

    // 2. Head straight into building your configurations safely
    const preferences = new SharedPreferences();
    let mainURL = `${mangayomiSources[0].baseUrl}/`;
    
    let configParams = "";
    configParams += this.appendQueryParam("providers", preferences.get("provider_selection"));
    configParams += this.appendQueryParam("language", preferences.get("lang_selection"));
    configParams += this.appendQueryParam("qualityfilter", preferences.get("quality_selection"));
    configParams += this.appendQueryParam("sort", new Set([preferences.get("sorting_link")]));
    
    configParams = configParams.replace(/\|$/, "");

    const debridService = preferences.get("debrid_service");
    const debridToken = preferences.get("debrid_token").trim();
    
    let debridParam = "";
    if (debridService !== "none" && debridToken !== "") {
        debridParam = `${debridService}=${debridToken}`;
    }

    if (configParams && debridParam) {
        mainURL += `${configParams}|${debridParam}`;
    } else if (configParams) {
        mainURL += configParams;
    } else if (debridParam) {
        mainURL += debridParam;
    }

    mainURL += targetUrl;

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

    return videos.slice(0, parseInt(numberOfLinks));
}

    sortVideos(videos) {
        const preferences = new SharedPreferences();

        const isDub = preferences.get("dubbed");
        const isEfficient = preferences.get("efficient");

        return videos.sort((a, b) => {
            const qualityA = a.quality || "";
            const qualityB = b.quality || "";

            const regexMatchA = /\[(.+?) download\]/.test(qualityA);
            const regexMatchB = /\[(.+?) download\]/.test(qualityB);

            const isDubA = isDub && !qualityA.toLowerCase().includes("dubbed");
            const isDubB = isDub && !qualityB.toLowerCase().includes("dubbed");

            const isEfficientA = isEfficient && !["hevc", "265", "av1"].some(q => qualityA.toLowerCase().includes(q));
            const isEfficientB = isEfficient && !["hevc", "265", "av1"].some(q => qualityB.toLowerCase().includes(q));

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
                        "🇭Croatian",
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
                        "🇮 Indonesia",
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
