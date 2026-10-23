export const TASK_ACTIVITY_PYTHON = String.raw`
import contextlib, hashlib, json, math, pathlib, re, signal, sqlite3, sys, time

class ReadDeadline(TimeoutError):
    pass

def deadline_signal(signum, frame):
    raise ReadDeadline()

def label(value):
    return value if isinstance(value, str) and 0 < len(value) <= 256 and not re.search(r'[\x00-\x1f\x7f]', value) else None

def emit(result):
    print(json.dumps(result, separators=(',', ':'), ensure_ascii=True))

def read_board(request):
    root = pathlib.Path(request['root'])
    board = request['board']
    window = request['window']
    caps = request['limits']
    candidate = root / ('kanban.db' if board == 'default' else 'kanban/boards/' + board + '/kanban.db')
    result = dict(board=board, databasePath=str(candidate), window=window, snapshotAt=int(time.time()*1000), schemaFingerprint='', highWaterEventId=None, qualifyingRowCount=0, malformedRowCount=0, missingAttributionCount=0, reasons=[], rows=[])
    reasons = result['reasons']
    def incomplete(reason):
        if reason not in reasons:
            reasons.append(reason)
    started = time.monotonic()
    try:
        signal.signal(signal.SIGALRM, deadline_signal)
        signal.setitimer(signal.ITIMER_REAL, caps['deadlineMs']/1000)
        resolved_root = root.resolve(strict=True)
        metadata = root / 'kanban' / 'boards' / board / 'board.json'
        if board != 'default' or metadata.exists():
            resolved_meta = metadata.resolve(strict=True)
            if not resolved_meta.is_relative_to(resolved_root) or resolved_meta != metadata:
                incomplete('missing-source')
                return result
            with resolved_meta.open('rb') as source:
                raw = source.read(65537)
            if len(raw) > 65536:
                incomplete('malformed-data')
                return result
            meta = json.loads(raw.decode('utf-8-sig'))
            if not isinstance(meta, dict) or meta.get('archived', False) is not False:
                incomplete('missing-source')
                return result
        path = candidate.resolve(strict=True)
        if resolved_root != root or path != candidate or not path.is_relative_to(resolved_root) or not path.is_file():
            incomplete('missing-source')
            return result
        with contextlib.closing(sqlite3.connect(path.as_uri()+'?mode=ro', uri=True, timeout=0.1)) as conn:
            conn.set_progress_handler(lambda: int(time.monotonic()-started >= caps['deadlineMs']/1000), 1000)
            try:
                conn.execute('BEGIN')
                schema = conn.execute("SELECT name,sql FROM sqlite_master WHERE type='table' AND name IN ('tasks','task_events') ORDER BY name").fetchall()
                result['schemaFingerprint'] = hashlib.sha256(json.dumps(schema,separators=(',',':')).encode()).hexdigest()
                tables = {row[0] for row in schema}
                task_info = conn.execute('PRAGMA table_info(tasks)').fetchall()
                event_info = conn.execute('PRAGMA table_info(task_events)').fetchall()
                task_columns = {row[1] for row in task_info}
                event_columns = {row[1] for row in event_info}
                if tables != {'tasks','task_events'} or not {'id','created_by'} <= task_columns or not {'id','task_id','kind','payload','created_at'} <= event_columns:
                    incomplete('unsupported-schema')
                    return result
                if not any(row[1]=='id' and row[2].upper()=='TEXT' and row[5]==1 for row in task_info) or not any(row[1]=='id' and row[2].upper()=='INTEGER' and row[5]==1 for row in event_info):
                    incomplete('unsupported-schema')
                    return result
                highwater = conn.execute('SELECT MAX(id) FROM task_events').fetchone()[0]
                if highwater is not None and (not isinstance(highwater,int) or not 0 < highwater <= 9007199254740991):
                    incomplete('malformed-data')
                    return result
                result['highWaterEventId'] = str(highwater) if highwater is not None else None
                cursor = conn.execute("SELECT e.id,e.task_id,e.kind,substr(e.payload,1,65537),e.created_at,t.created_by FROM task_events e LEFT JOIN tasks t ON t.id=e.task_id WHERE e.id<=? AND e.kind IN ('created','assigned','review_requested','changes_requested') ORDER BY e.id", (highwater or 0,))
                projected_bytes = len(json.dumps(result,separators=(',',':'),ensure_ascii=True).encode()) + 512
                for event_id, task_id, kind, payload, stamp, creator in cursor:
                    if time.monotonic()-started >= caps['deadlineMs']/1000:
                        incomplete('deadline')
                        break
                    if not isinstance(stamp,(int,float)) or not math.isfinite(stamp) or stamp < 0 or stamp*1000 > 8640000000000000:
                        result['malformedRowCount'] += 1
                        incomplete('malformed-data')
                        continue
                    occurred = stamp*1000
                    if occurred >= window['end'] or (window['start'] is not None and occurred < window['start']):
                        continue
                    result['qualifyingRowCount'] += 1
                    if result['qualifyingRowCount'] > caps['rowsPerBoard']:
                        incomplete('row-cap')
                        break
                    if not isinstance(event_id,int) or not 0 < event_id <= 9007199254740991 or not isinstance(task_id,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}',task_id):
                        result['malformedRowCount'] += 1
                        incomplete('malformed-data')
                        continue
                    malformed = False
                    try:
                        data = json.loads(payload) if isinstance(payload,str) and len(payload)<=65536 else None
                    except (json.JSONDecodeError, RecursionError):
                        data = None
                    if not isinstance(data,dict):
                        data = {}
                        malformed = True
                        result['malformedRowCount'] += 1
                        incomplete('malformed-data')
                    match kind:
                        case 'created':
                            activity_type, source, target = 'creation', label(creator), label(data.get('assignee'))
                        case 'assigned':
                            activity_type, source, target = 'transfer', label(data.get('from')), label(data.get('assignee'))
                        case 'review_requested':
                            activity_type, source, target = 'review', label(data.get('implementer')), label(data.get('reviewer'))
                        case 'changes_requested':
                            activity_type, source, target = 'revision', label(data.get('reviewer')), label(data.get('implementer'))
                        case _:
                            raise RuntimeError('closed query returned unsupported event')
                    if source is None or target is None:
                        result['missingAttributionCount'] += 1
                        incomplete('missing-attribution')
                    row = dict(eventId=str(event_id),taskId=task_id,type=activity_type,occurredAt=occurred,source=source,target=target,malformed=malformed)
                    projected_bytes += len(json.dumps(row,separators=(',',':'),ensure_ascii=True).encode())+1
                    if projected_bytes > caps['bytesPerBoard']:
                        incomplete('byte-cap')
                        break
                    result['rows'].append(row)
            finally:
                conn.rollback()
    except ReadDeadline:
        incomplete('deadline')
    except (FileNotFoundError, NotADirectoryError, PermissionError):
        incomplete('missing-source')
    except (json.JSONDecodeError, UnicodeDecodeError, RecursionError):
        incomplete('malformed-data')
    except sqlite3.Error:
        incomplete('deadline' if time.monotonic()-started >= caps['deadlineMs']/1000 else 'unsupported-schema')
    except OSError:
        incomplete('missing-source')
    finally:
        signal.setitimer(signal.ITIMER_REAL,0)
    return result

emit(read_board(json.loads(sys.argv[1])))
`;
