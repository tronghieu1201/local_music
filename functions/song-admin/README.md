# Song-admin playback URL configuration

The `get-playback-url` action accepts an Appwrite song row ID. The Function reads the row and its Storage file using the caller's Appwrite permissions. When `LOCAL_SOUND_S3_READ_API_KEY` is set, it checks that the full Storage key (folder plus file name) maps to exactly one file and returns a six-hour S3-compatible presigned GET URL. Without that key, it returns the verified file's native Storage `/view` URL. The browser uses `HTMLAudioElement` for both sources.

For the new Appwrite project, the Function must receive these non-secret variables:

| Variable | Value |
| --- | --- |
| `LOCAL_SOUND_DATABASE_ID` | `6ab3c1c70002db082d00` |
| `LOCAL_SOUND_TABLE_ID` | `songs` |
| `LOCAL_SOUND_REQUESTS_TABLE_ID` | `song_requests` |
| `LOCAL_SOUND_BUCKET_ID` | `6ab3a724003a859f835a` |
| `LOCAL_SOUND_ADMIN_USER_ID` | `6ab3f33c001d0e271d16` |
| `LOCAL_SOUND_ADMIN_TEAM_ID` | `6ab4df00001a34c983dc` |

Appwrite injects `APPWRITE_FUNCTION_API_ENDPOINT` and `APPWRITE_FUNCTION_PROJECT_ID` into the Function. Verify that they resolve to `https://sgp.cloud.appwrite.io/v1` and `6ab3a652002e667289ab` in the new project. The execution API key is also supplied by Appwrite at runtime through `x-appwrite-key`; do not put it in source control.

For S3 playback, set this secret variable on the `song-admin` Function in Appwrite Console after revoking the exposed key:

| Variable | Value |
| --- | --- |
| `LOCAL_SOUND_S3_READ_API_KEY` | A newly issued, secret Appwrite API key with only `buckets.read` and `files.read` scopes |

The disclosed `S3_READ_API_KEY` and the former `APPWRITE_S3_READ_API_KEY` names are deliberately ignored by this version of the Function. Revoke the exposed key in Appwrite Console; changing the variable name alone does not revoke it. The Function never returns the replacement key to the browser or writes it to logs.

If no S3 read key is configured, the Function still checks the requested Database row and Storage file with the caller's permissions, then supplies that verified file's Storage `/view` URL. If the caller cannot read the row or file, it returns no URL.

The native `/view` URL has no six-hour signature expiry; the `expiresAt` response field is a client cache refresh deadline in that mode. An S3 URL is actually signed for six hours. Do not add either URL to logs.

The S3 endpoint is derived from `APPWRITE_FUNCTION_API_ENDPOINT` and defaults to `https://<REGION>.cloud.appwrite.io/v1/s3`. `APPWRITE_S3_ENDPOINT` can override it for a custom Appwrite endpoint. `APPWRITE_S3_REGION` is optional; the Function derives the Appwrite Cloud region from the endpoint host, or uses `auto` for a custom host.

Keep the API key secret in Function environment variables. Do not add it to the frontend, source control, or logs. The Function's execute permission can remain `any` only because each request resolves the song row and Storage file through the caller's own read permissions before signing; duplicate full keys are rejected. On a media error, the frontend may call `diagnose-playback`, which rechecks the same row/file permission and makes one `Range: bytes=0-0` S3 request. It returns only status, a sanitized S3 error code, and a same-project `/view` URL when the S3 response is not an authorization failure. The media player still streams through `HTMLAudioElement`; it never fetches the full MP3 into a Blob.

## Playback incident check before deployment

On localhost, the row for “Ác Mộng Đẹp” and its Storage file `6ab6447a0029afd8ee6f` both return HTTP 200. The file's native `/view` response is `audio/mpeg` and plays and seeks in a browser. The currently deployed `get-playback-url` execution returns an inner HTTP 502, while Appwrite's outer `createExecution` request returns 201. The deployed Function's error response does not identify the failing stage, so the precise server-side cause is not yet observable from the browser. The connected Function in `appwrite.config.json` tracks the repository's `main` branch; the local source changes in this directory are not deployed.

The Console variable names supplied on 2026-10-29 confirm that the active Function still has `S3_READ_API_KEY` and does not have `LOCAL_SOUND_S3_READ_API_KEY`. Its active Git commit `95c6598` reads `S3_READ_API_KEY`, so it enters the S3 signing branch. A bad or revoked key, insufficient scopes, or a different S3-stage failure can all produce the observed generic 502 in that deployment; the execution log is needed to distinguish them. Appwrite applies variable additions, changes, and deletions only after a new deployment, so changing the variable alone will not fix the active deployment.

Before activating a new deployment, check these Function variables in Appwrite Console: `LOCAL_SOUND_DATABASE_ID=6ab3c1c70002db082d00`, `LOCAL_SOUND_TABLE_ID=songs`, `LOCAL_SOUND_BUCKET_ID=6ab3a724003a859f835a`, and the injected endpoint/project ID above. Revoke the exposed key and remove the legacy `S3_READ_API_KEY` and `APPWRITE_S3_READ_API_KEY` variables. Leave `LOCAL_SOUND_S3_READ_API_KEY` unset for permission-checked native `/view` playback, or set it to a newly issued secret with only `buckets.read` and `files.read` if S3 playback is required. Do not paste the secret into this repository.

This source reports the safe failing stage and upstream HTTP status for S3 credential errors. After you approve and activate its deployment, test `get-playback-url` for the row ID of “Ác Mộng Đẹp”: the Function response status should be 200, `sourceKind` should be `view` when no new S3 key is set (or `s3` when one is set), and the browser should play, pause, seek and advance without logging the returned URL. A 503 at stage `s3-file-lookup` with upstream 401/403 means the configured S3 key is invalid or lacks the required read scopes.

The project config selects the `node-26` runtime, which matches this Function's `node >=26` package requirement. Appwrite CLI execution logs for deployment `6acf4bed20ae1dcbcf2c` confirm repeated HTTP 502 responses. The recorded error is only `{"tag":"playback-url-failed","stage":"permission-check-or-signing","status":502}`, so this active deployment does not reveal which call failed. Its build log shows that dependencies installed and the deployment finished successfully. The active deployment is built from `mosaic-works/local-sound` commit `95c6598`; pushing to a different GitHub repository will not activate the local fix. Once signed in, a reviewer can create a deployment from this local directory without changing the connected GitHub repository:

```sh
appwrite functions create-deployment --function-id song-admin --code functions/song-admin --entrypoint src/main.js --commands "npm install"
```

Wait until that deployment is `ready`, inspect its build log, then activate the reviewed deployment ID with `appwrite functions update-function-deployment --function-id song-admin --deployment-id <DEPLOYMENT_ID>`. These commands are instructions only; they were not run during this investigation.
