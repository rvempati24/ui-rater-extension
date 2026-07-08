import { google } from 'googleapis';
import fs from 'fs';

/**
 * Uploads a local file to a Google Drive folder using OAuth 2.0.
 *
 * Required env vars:
 *   GOOGLE_CLIENT_ID      — OAuth 2.0 client ID
 *   GOOGLE_CLIENT_SECRET  — OAuth 2.0 client secret
 *   GOOGLE_REFRESH_TOKEN  — refresh token obtained via scripts/get-refresh-token.mjs
 *   GOOGLE_DRIVE_FOLDER_ID — ID of the target Drive folder
 */
export async function uploadToDrive(localPath: string, filename: string): Promise<void> {
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  const folderId     = process.env.GOOGLE_DRIVE_FOLDER_ID;

  if (!clientId || !clientSecret || !refreshToken || !folderId) {
    console.warn('[gdrive] Skipping — GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, or GOOGLE_DRIVE_FOLDER_ID not set');
    return;
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, 'http://localhost:3001');
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  const drive = google.drive({ version: 'v3', auth: oauth2Client });

  await drive.files.create({
    requestBody: {
      name: filename,
      parents: [folderId],
    },
    media: {
      mimeType: 'application/json',
      body: fs.createReadStream(localPath),
    },
  });

  console.log(`[gdrive] Uploaded ${filename} to Drive folder ${folderId}`);
}
