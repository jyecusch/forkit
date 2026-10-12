export namespace model {
	
	export class CallMeta {
	    traceparent: string;
	
	    static createFrom(source: any = {}) {
	        return new CallMeta(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.traceparent = source["traceparent"];
	    }
	}
	export class CheckoutResult {
	    reapplyConflicted: boolean;
	
	    static createFrom(source: any = {}) {
	        return new CheckoutResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.reapplyConflicted = source["reapplyConflicted"];
	    }
	}
	export class Commit {
	    oid: string;
	    parents?: string[];
	    authorName: string;
	    authorEmail: string;
	    authorTime: number;
	    committerTime: number;
	    subject: string;
	
	    static createFrom(source: any = {}) {
	        return new Commit(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.oid = source["oid"];
	        this.parents = source["parents"];
	        this.authorName = source["authorName"];
	        this.authorEmail = source["authorEmail"];
	        this.authorTime = source["authorTime"];
	        this.committerTime = source["committerTime"];
	        this.subject = source["subject"];
	    }
	}
	export class FileChange {
	    path: string;
	    oldPath?: string;
	    status: string;
	    additions: number;
	    deletions: number;
	    binary: boolean;
	
	    static createFrom(source: any = {}) {
	        return new FileChange(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.oldPath = source["oldPath"];
	        this.status = source["status"];
	        this.additions = source["additions"];
	        this.deletions = source["deletions"];
	        this.binary = source["binary"];
	    }
	}
	export class CommitDetail {
	    oid: string;
	    parents?: string[];
	    authorName: string;
	    authorEmail: string;
	    authorTime: number;
	    committerName: string;
	    committerEmail: string;
	    committerTime: number;
	    body: string;
	    files?: FileChange[];
	
	    static createFrom(source: any = {}) {
	        return new CommitDetail(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.oid = source["oid"];
	        this.parents = source["parents"];
	        this.authorName = source["authorName"];
	        this.authorEmail = source["authorEmail"];
	        this.authorTime = source["authorTime"];
	        this.committerName = source["committerName"];
	        this.committerEmail = source["committerEmail"];
	        this.committerTime = source["committerTime"];
	        this.body = source["body"];
	        this.files = this.convertValues(source["files"], FileChange);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class GraphEdge {
	    fromLane: number;
	    toLane: number;
	    threadId: number;
	    kind: string;
	    onEmphasized: boolean;
	
	    static createFrom(source: any = {}) {
	        return new GraphEdge(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.fromLane = source["fromLane"];
	        this.toLane = source["toLane"];
	        this.threadId = source["threadId"];
	        this.kind = source["kind"];
	        this.onEmphasized = source["onEmphasized"];
	    }
	}
	export class GraphRow {
	    index: number;
	    oid: string;
	    lane: number;
	    threadId: number;
	    edges?: GraphEdge[];
	    refIds?: string[];
	    onEmphasized: boolean;
	
	    static createFrom(source: any = {}) {
	        return new GraphRow(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.index = source["index"];
	        this.oid = source["oid"];
	        this.lane = source["lane"];
	        this.threadId = source["threadId"];
	        this.edges = this.convertValues(source["edges"], GraphEdge);
	        this.refIds = source["refIds"];
	        this.onEmphasized = source["onEmphasized"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class GraphWindow {
	    version: number;
	    start: number;
	    rows?: GraphRow[];
	    commits?: Commit[];
	
	    static createFrom(source: any = {}) {
	        return new GraphWindow(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.version = source["version"];
	        this.start = source["start"];
	        this.rows = this.convertValues(source["rows"], GraphRow);
	        this.commits = this.convertValues(source["commits"], Commit);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Repo {
	    id: string;
	    name: string;
	    commonDir: string;
	    isBare: boolean;
	    defaultBranch: string;
	    mainWorktreeId: string;
	    lastOpenedAt: number;
	    state: string;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new Repo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.commonDir = source["commonDir"];
	        this.isBare = source["isBare"];
	        this.defaultBranch = source["defaultBranch"];
	        this.mainWorktreeId = source["mainWorktreeId"];
	        this.lastOpenedAt = source["lastOpenedAt"];
	        this.state = source["state"];
	        this.error = source["error"];
	    }
	}
	export class StatusSummary {
	    staged: number;
	    unstaged: number;
	    untracked: number;
	    conflicted: number;
	
	    static createFrom(source: any = {}) {
	        return new StatusSummary(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.staged = source["staged"];
	        this.unstaged = source["unstaged"];
	        this.untracked = source["untracked"];
	        this.conflicted = source["conflicted"];
	    }
	}
	export class SyncSnapshot {
	    seq: number;
	    entities?: any[];
	
	    static createFrom(source: any = {}) {
	        return new SyncSnapshot(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.seq = source["seq"];
	        this.entities = source["entities"];
	    }
	}
	export class WorktreeHead {
	    kind: string;
	    refId?: string;
	    oid: string;
	
	    static createFrom(source: any = {}) {
	        return new WorktreeHead(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.kind = source["kind"];
	        this.refId = source["refId"];
	        this.oid = source["oid"];
	    }
	}
	export class Worktree {
	    id: string;
	    repoId: string;
	    path: string;
	    isMain: boolean;
	    locked: boolean;
	    prunable: boolean;
	    head: WorktreeHead;
	    operation: string;
	    statusSummary: StatusSummary;
	
	    static createFrom(source: any = {}) {
	        return new Worktree(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.repoId = source["repoId"];
	        this.path = source["path"];
	        this.isMain = source["isMain"];
	        this.locked = source["locked"];
	        this.prunable = source["prunable"];
	        this.head = this.convertValues(source["head"], WorktreeHead);
	        this.operation = source["operation"];
	        this.statusSummary = this.convertValues(source["statusSummary"], StatusSummary);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

