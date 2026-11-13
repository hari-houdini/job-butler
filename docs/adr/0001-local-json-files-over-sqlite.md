# Pipeline state is stored as local JSON files, not SQLite

Pipeline state is one JSON file per record in the private data directory, written only by the main-session Stage skill. SQLite was rejected because the store must work the same on macOS, Linux and Windows, and plain files need no driver or binary; the cost is that writes need write-then-replace and a lock file in place of transactions. Decided in [Where does pipeline state live?](https://github.com/hari-houdini/job-butler/issues/8).
