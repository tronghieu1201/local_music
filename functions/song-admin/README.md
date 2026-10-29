# Song-admin playback URL configuration

The `get-playback-url` action accepts an Appwrite song row ID. The Function reads the row and its Storage file using the caller's Appwrite permissions, checks that the full Storage key (folder plus file name) maps to exactly one file, and returns a six-hour S3-compatible presigned GET URL. The browser keeps using its existing `HTMLAudioElement` and requests byte ranges directly from Appwrite S3.

For S3 playback, set this environment variable on the `song-admin` Function in Appwrite Console:

| Variable | Value |
| --- | --- |
| `APPWRITE_S3_READ_API_KEY` | Secret for a dedicated Appwrite API key with only `buckets.read` and `files.read` scopes |

`S3_READ_API_KEY` remains accepted as a compatibility alias for an existing deployment. Set `APPWRITE_S3_READ_API_KEY` for new deployments. The Function never returns this key to the browser or writes it to logs.

If no S3 read key is configured, the Function still checks the requested Database row and Storage file with the caller's permissions, then supplies that verified file's Storage `/view` URL. If the caller cannot read the row or file, it returns no URL.

The S3 endpoint is derived from `APPWRITE_FUNCTION_API_ENDPOINT` and defaults to `https://<REGION>.cloud.appwrite.io/v1/s3`. `APPWRITE_S3_ENDPOINT` can override it for a custom Appwrite endpoint. `APPWRITE_S3_REGION` is optional; the Function derives the Appwrite Cloud region from the endpoint host, or uses `auto` for a custom host.

Keep the API key secret in Function environment variables. Do not add it to the frontend, source control, or logs. The Function's execute permission can remain `any` only because each request resolves the song row and Storage file through the caller's own read permissions before signing; duplicate full keys are rejected. On a media error, the frontend may call `diagnose-playback`, which rechecks the same row/file permission and makes one `Range: bytes=0-0` S3 request. It returns only status, a sanitized S3 error code, and a same-project `/view` URL when the S3 response is not an authorization failure. The media player still streams through `HTMLAudioElement`; it never fetches the full MP3 into a Blob.
