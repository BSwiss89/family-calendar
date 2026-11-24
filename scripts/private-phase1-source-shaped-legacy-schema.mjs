// Synthetic fixture schema only. Never execute archived DDL or open any calendar.
// Source-shaped definitions shared by conversion tests and the read-only comparator.
import {createFamilyAuthTables} from '../Server/family-auth.mjs'
import {installAssignmentNotificationOutbox} from '../Server/event-assignment-notifications.mjs'
import {installNotificationMutationCapture} from '../Server/notification-event-mutation-capture.mjs'
const schema = `
CREATE TABLE events (
 id INTEGER PRIMARY KEY,date TEXT NOT NULL,end_date TEXT,title TEXT NOT NULL,
 time TEXT,end_time TEXT,person TEXT,notes TEXT,batch_id TEXT,location TEXT,
 repeat_unit TEXT,repeat_interval INTEGER,repeat_end_type TEXT,
 repeat_end_date TEXT,repeat_count INTEGER
) STRICT;
CREATE TABLE people (
 id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE,color TEXT NOT NULL,
 image TEXT,sort_order INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE event_people (
 event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
 person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
 PRIMARY KEY(event_id,person_id)
) STRICT;
CREATE TABLE event_exceptions (
 event_id INTEGER NOT NULL,occurrence_date TEXT NOT NULL,
 PRIMARY KEY(event_id,occurrence_date),
 FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
) STRICT;
CREATE TABLE lists (
 id INTEGER PRIMARY KEY,name TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 store_enabled INTEGER NOT NULL DEFAULT 0,icon TEXT
) STRICT;
CREATE TABLE list_items (
 id INTEGER PRIMARY KEY,list_id INTEGER NOT NULL,text TEXT NOT NULL,
 completed INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 sort_order INTEGER NOT NULL DEFAULT 0,category TEXT NOT NULL DEFAULT 'General',
 store_id INTEGER,store_manual INTEGER NOT NULL DEFAULT 0,
 FOREIGN KEY(list_id) REFERENCES lists(id) ON DELETE CASCADE
) STRICT;
CREATE TABLE meal_plans (
 id INTEGER PRIMARY KEY,date TEXT NOT NULL UNIQUE,dinner TEXT NOT NULL,notes TEXT
) STRICT;
CREATE TABLE daily_notes (
 date TEXT PRIMARY KEY,note TEXT NOT NULL DEFAULT '',
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
CREATE TABLE recipes (
 id INTEGER PRIMARY KEY,name TEXT NOT NULL,image TEXT,servings INTEGER,
 prep_time TEXT,cook_time TEXT,ingredients TEXT NOT NULL DEFAULT '',
 instructions TEXT NOT NULL DEFAULT '',notes TEXT,tags TEXT,
 favorite INTEGER NOT NULL DEFAULT 0,source_url TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,source_image TEXT
) STRICT;
CREATE TABLE meal_plan_items (
 id INTEGER PRIMARY KEY,date TEXT NOT NULL,meal_type TEXT NOT NULL,
 recipe_id INTEGER,title TEXT NOT NULL,notes TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(recipe_id) REFERENCES recipes(id) ON DELETE SET NULL,
 UNIQUE(date,meal_type)
) STRICT;
CREATE TABLE capture_inbox (
 id INTEGER PRIMARY KEY,image TEXT NOT NULL,original_name TEXT,mime_type TEXT,note TEXT,
 status TEXT NOT NULL DEFAULT 'new',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,capture_type TEXT,
 analysis_status TEXT NOT NULL DEFAULT 'pending',analysis_json TEXT
) STRICT;
CREATE TABLE shopping_stores (
 id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE COLLATE NOCASE,
 enabled INTEGER NOT NULL DEFAULT 1,sort_order INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE shopping_store_preferences (
 item_key TEXT PRIMARY KEY,store_id INTEGER REFERENCES shopping_stores(id) ON DELETE SET NULL
) STRICT;
CREATE TABLE emoji_markers (
 id INTEGER PRIMARY KEY,date TEXT NOT NULL,emoji TEXT NOT NULL,label TEXT NOT NULL DEFAULT '',
 repeat_unit TEXT,repeat_interval INTEGER,repeat_weekdays TEXT,repeat_month_pattern TEXT,
 repeat_end_type TEXT,repeat_end_date TEXT,repeat_count INTEGER
) STRICT;
CREATE TABLE emoji_marker_exceptions (
 marker_id INTEGER NOT NULL,occurrence_date TEXT NOT NULL,
 PRIMARY KEY(marker_id,occurrence_date),
 FOREIGN KEY(marker_id) REFERENCES emoji_markers(id) ON DELETE CASCADE
) STRICT;
CREATE TABLE test_event_invitations (
 id INTEGER PRIMARY KEY,event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
 person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
 invited_by_person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','accepted','declined')),
 created_at INTEGER NOT NULL,responded_at INTEGER,UNIQUE(event_id,person_id)
) STRICT;
CREATE INDEX test_invitations_pending ON test_event_invitations(person_id,status,created_at);
CREATE TABLE test_push_subscriptions (
 endpoint_hash TEXT PRIMARY KEY,endpoint TEXT NOT NULL,p256dh TEXT NOT NULL,auth TEXT NOT NULL,
 user_id INTEGER NOT NULL,session_id INTEGER NOT NULL,person_id INTEGER NOT NULL,
 subscribed_at INTEGER NOT NULL
) STRICT;
CREATE INDEX test_push_profiles ON test_push_subscriptions(person_id,session_id);
CREATE TABLE test_push_deliveries (
 notification_id INTEGER NOT NULL,endpoint_hash TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'pending',PRIMARY KEY(notification_id,endpoint_hash)
) STRICT;
`
export function installSourceShapedSyntheticLegacySchema(db) {
  db.exec(schema)
  createFamilyAuthTables(db)
  installAssignmentNotificationOutbox(db)
  installNotificationMutationCapture(db)
  db.exec('CREATE TABLE test_assignment_acknowledgements(notification_id INTEGER PRIMARY KEY REFERENCES assignment_notification_outbox(id),acknowledged_at INTEGER NOT NULL CHECK(acknowledged_at > 0)) STRICT')
}
