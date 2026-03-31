const DETAILS_REGEX = /^https?:\/\/archive\.org\/details\/([a-zA-Z0-9_\-.]+)($|\/$|\?.*?$)/;
const METADATA_URL_PREFIX = "https://archive.org/metadata/";
const DOWNLOAD_URL_PREFIX = "https://archive.org/download/";
const SEARCH_URL = "https://archive.org/advancedsearch.php";
const PLATFORM = "Internet Archive";
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0";
const local_http = http;
// set missing constants
// @ts-ignore
Type.Order.Chronological = "Latest releases";
// @ts-ignore
Type.Order.Views = "Most played";
// @ts-ignore
Type.Order.Favorites = "Most favorited";
//#region source methods
const local_source = {
    enable,
    disable,
    saveState,
    getHome,
    search,
    getSearchCapabilities,
    isContentDetailsUrl,
    getVideoDetails: getContentDetails,
    isChannelUrl,
    getChannel,
    getChannelContents,
    getChannelCapabilities,
    searchChannels,
};
init_source(local_source);
function init_source(local_source) {
    for (const method_key of Object.keys(local_source)) {
        // @ts-expect-error assign to readonly constant source object
        source[method_key] = local_source[method_key];
    }
}
//#endregion
//#region enable
function enable(_conf, _settings, _savedState) {
}
function disable() {
    log("Internet Archive log: disabling");
}
function saveState() {
    return "{}";
}
//#endregion
//#region home
function getHome() {
    return search("mediatype:movies AND collection:feature_films", null, null, null);
}
//#endregion
//#region search
function getSearchCapabilities() {
    return new ResultCapabilities([Type.Feed.Mixed], [Type.Order.Chronological, Type.Order.Views], []);
}
function search(query, _type, order, _filters) {
    return new IASearchPager(query, 1, 50, order);
}
class IASearchPager extends VideoPager {
    query;
    limit;
    order;
    page;
    constructor(query, page, limit, order) {
        const search_response = fetchSearch(query, page, limit, order);
        const results = formatSearchDocs(search_response.response.docs);
        const has_more = search_response.response.numFound > page * limit;
        super(results, has_more);
        this.query = query;
        this.limit = limit;
        this.order = order;
        this.page = page;
    }
    nextPage() {
        this.page++;
        const search_response = fetchSearch(this.query, this.page, this.limit, this.order);
        this.results = formatSearchDocs(search_response.response.docs);
        this.hasMore = search_response.response.numFound > this.page * this.limit;
        return this;
    }
    hasMorePagers() {
        return this.hasMore;
    }
}
function fetchSearch(query, page, limit, order) {
    const url = new URL(SEARCH_URL);
    url.searchParams.set("q", query);
    url.searchParams.set("rows", limit.toString());
    url.searchParams.set("page", page.toString());
    url.searchParams.set("output", "json");
    url.searchParams.set("fl[]", "identifier,title,description,mediatype,collection,creator,date,runtime");
    if (order === Type.Order.Chronological) {
        url.searchParams.set("sort[]", "addeddate desc");
    }
    else if (order === Type.Order.Views) {
        url.searchParams.set("sort[]", "downloads desc");
    }
    const response = local_http.GET(url.toString(), { "User-Agent": USER_AGENT }, false);
    if (!response.isOk) {
        throw new ScriptException(`Search failed: ${response.code}`);
    }
    return JSON.parse(response.body);
}
function formatSearchDocs(docs) {
    return docs.map(doc => {
        const author_name = doc.creator ? (Array.isArray(doc.creator) ? doc.creator[0] : doc.creator) : (doc.collection ? doc.collection[0] : "Internet Archive");
        const author_id = doc.collection ? doc.collection[0] : "internetarchive";
        return new PlatformVideo({
            id: new PlatformID(PLATFORM, doc.identifier, plugin.config.id),
            name: doc.title || doc.identifier,
            author: new PlatformAuthorLink(new PlatformID(PLATFORM, author_id || "unknown", plugin.config.id), author_name || "Unknown", `https://archive.org/details/${author_id}`),
            url: `https://archive.org/details/${doc.identifier}`,
            thumbnails: new Thumbnails([
                new Thumbnail(`https://archive.org/services/img/${doc.identifier}`, 0)
            ]),
            duration: parseRuntime(doc.runtime) || 0,
            viewCount: 0,
            isLive: false,
            shareUrl: `https://archive.org/details/${doc.identifier}`,
            datetime: doc.date ? new Date(doc.date).getTime() / 1000 : 0
        });
    });
}
function parseRuntime(runtime) {
    if (!runtime)
        return null;
    // IA runtime can be "HH:MM:SS", "MM:SS", or even just minutes
    const parts = runtime.split(":").map(Number);
    if (parts.length === 3) {
        // @ts-ignore
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    else if (parts.length === 2) {
        // @ts-ignore
        return parts[0] * 60 + parts[1];
    }
    else if (parts.length === 1) {
        // @ts-ignore
        return parts[0] * 60;
    }
    return null;
}
//#endregion
//#region content
function isContentDetailsUrl(url) {
    return DETAILS_REGEX.test(url);
}
function getContentDetails(url) {
    const match = url.match(DETAILS_REGEX);
    if (!match || !match[1])
        throw new ScriptException("Invalid IA URL");
    const identifier = match[1];
    const response = local_http.GET(`${METADATA_URL_PREFIX}${identifier}`, { "User-Agent": USER_AGENT }, false);
    if (!response.isOk)
        throw new ScriptException("Failed to fetch IA metadata");
    const metadata = JSON.parse(response.body);
    const video_files = metadata.files.filter(f => f.format === "MPEG4" || f.format === "h.264" || f.format === "WebM" || f.format === "Ogg Video");
    if (video_files.length === 0)
        throw new ScriptException("No playable video files found");
    // Sort to prefer MPEG4 and then by size/length
    video_files.sort((a, b) => {
        if (a.format === "MPEG4" && b.format !== "MPEG4")
            return -1;
        if (a.format !== "MPEG4" && b.format === "MPEG4")
            return 1;
        return (parseInt(b.size || "0") - parseInt(a.size || "0"));
    });
    const video_sources = video_files.map(f => {
        const codec = f.format === "MPEG4" ? "avc1.42E01E, mp4a.40.2" : "";
        const source_def = {
            width: parseInt(f.width || "0"),
            height: parseInt(f.height || "0"),
            container: f.name.endsWith(".mp4") ? "video/mp4" : (f.name.endsWith(".webm") ? "video/webm" : "video/ogg"),
            codec: codec,
            name: f.format,
            bitrate: 0,
            duration: parseRuntime(f.length) || parseRuntime(metadata.metadata.runtime) || 0,
            url: `${DOWNLOAD_URL_PREFIX}${identifier}/${f.name}`
        };
        return new VideoUrlSource(source_def);
    });
    const author_name = metadata.metadata.creator ? (Array.isArray(metadata.metadata.creator) ? metadata.metadata.creator[0] : metadata.metadata.creator) : (metadata.metadata.uploader || "Internet Archive");
    const author_id = metadata.metadata.collection ? metadata.metadata.collection[0] : "internetarchive";
    return new PlatformVideoDetails({
        id: new PlatformID(PLATFORM, identifier, plugin.config.id),
        name: metadata.metadata.title || identifier,
        author: new PlatformAuthorLink(new PlatformID(PLATFORM, author_id || "unknown", plugin.config.id), author_name || "Unknown", `https://archive.org/details/${author_id}`),
        url: `https://archive.org/details/${identifier}`,
        thumbnails: new Thumbnails([
            new Thumbnail(`https://archive.org/services/img/${identifier}`, 0)
        ]),
        duration: parseRuntime(metadata.metadata.runtime) || 0,
        viewCount: 0,
        isLive: false,
        shareUrl: `https://archive.org/details/${identifier}`,
        datetime: metadata.metadata.publicdate ? new Date(metadata.metadata.publicdate).getTime() / 1000 : 0,
        description: metadata.metadata.description || "",
        video: new VideoSourceDescriptor(video_sources),
        rating: new RatingLikes(0)
    });
}
//#endregion
//#region channels
function isChannelUrl(url) {
    return DETAILS_REGEX.test(url); // For IA, details page can also be a collection/user page
}
function getChannel(url) {
    const match = url.match(DETAILS_REGEX);
    if (!match || !match[1])
        throw new ScriptException("Invalid IA URL");
    const identifier = match[1];
    const response = local_http.GET(`${METADATA_URL_PREFIX}${identifier}`, { "User-Agent": USER_AGENT }, false);
    if (!response.isOk)
        throw new ScriptException("Failed to fetch IA metadata");
    const metadata = JSON.parse(response.body);
    const def = {
        id: new PlatformID(PLATFORM, identifier, plugin.config.id),
        name: metadata.metadata.title || identifier,
        thumbnail: `https://archive.org/services/img/${identifier}`,
        subscribers: 0,
        description: metadata.metadata.description || "",
        url: `https://archive.org/details/${identifier}`
    };
    return new PlatformChannel(def);
}
function getChannelCapabilities() {
    return new ResultCapabilities([Type.Feed.Mixed], [Type.Order.Chronological, Type.Order.Views], []);
}
function getChannelContents(url, type, order, filters) {
    const match = url.match(DETAILS_REGEX);
    if (!match || !match[1])
        throw new ScriptException("Invalid IA URL");
    const identifier = match[1];
    const query = `(collection:${identifier} OR uploader:${identifier}) AND mediatype:video`;
    return search(query, type, order, filters);
}
function searchChannels(query) {
    const url = new URL(SEARCH_URL);
    url.searchParams.set("q", `${query} AND mediatype:collection`);
    url.searchParams.set("rows", "20");
    url.searchParams.set("output", "json");
    url.searchParams.set("fl[]", "identifier,title,description");
    const response = local_http.GET(url.toString(), { "User-Agent": USER_AGENT }, false);
    if (!response.isOk)
        throw new ScriptException("Channel search failed");
    const search_response = JSON.parse(response.body);
    const channels = search_response.response.docs.map(doc => new PlatformChannel({
        id: new PlatformID(PLATFORM, doc.identifier, plugin.config.id),
        name: doc.title || doc.identifier,
        thumbnail: `https://archive.org/services/img/${doc.identifier}`,
        url: `https://archive.org/details/${doc.identifier}`,
        description: doc.description || ""
    }));
    return new IAChannelPager(channels, search_response.response.numFound > 20, query, 1);
}
class IAChannelPager extends ChannelPager {
    query;
    page;
    constructor(results, hasMore, query, page) {
        super(results, hasMore);
        this.query = query;
        this.page = page;
    }
    nextPage() {
        this.page++;
        const url = new URL(SEARCH_URL);
        url.searchParams.set("q", `${this.query} AND mediatype:collection`);
        url.searchParams.set("rows", "20");
        url.searchParams.set("page", this.page.toString());
        url.searchParams.set("output", "json");
        url.searchParams.set("fl[]", "identifier,title,description");
        const response = local_http.GET(url.toString(), { "User-Agent": USER_AGENT }, false);
        if (!response.isOk)
            return this;
        const search_response = JSON.parse(response.body);
        this.results = search_response.response.docs.map(doc => new PlatformChannel({
            id: new PlatformID(PLATFORM, doc.identifier, plugin.config.id),
            name: doc.title || doc.identifier,
            thumbnail: `https://archive.org/services/img/${doc.identifier}`,
            url: `https://archive.org/details/${doc.identifier}`,
            description: doc.description || ""
        }));
        this.hasMore = search_response.response.numFound > this.page * 20;
        return this;
    }
}
//#endregion
// Used for unit testing
export { parseRuntime };
// @ts-ignore
console.log(parseRuntime);
//# sourceMappingURL=InternetArchiveScript.js.map
