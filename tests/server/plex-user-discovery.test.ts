import assert from "node:assert/strict";
import test from "node:test";
import { PlexIntegration } from "../../src/server/integrations/plex.js";
import { createCapturingLogger } from "./test-helpers.js";

const plexSettings = {
  serverUrl: "http://plex.test",
  token: "test-token",
  machineIdentifier: "machine-id",
  movieLibraryId: "movies",
  showLibraryId: "shows"
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function xmlResponse(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/xml" }
  });
}

test("discoverUsers adds shared Plex users after resolving their Community UUID", async () => {
  const { logger } = createCapturingLogger();
  const plex = new PlexIntegration(plexSettings, logger);
  const originalFetch = globalThis.fetch;
  const resolvedUsernames: string[] = [];

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith("https://community.plex.tv/api")) {
      const body = JSON.parse(String(init?.body)) as { query: string; variables?: { user?: { username?: string } } };
      if (body.query.includes("GetAllFriends")) {
        return jsonResponse({
          data: {
            allFriendsV2: [{
              user: { id: "friend-uuid", username: "friend", displayName: "Friend", avatar: null }
            }]
          }
        });
      }

      const username = body.variables?.user?.username;
      assert.equal(username, "shared-user");
      resolvedUsernames.push(username);
      return jsonResponse({
        data: {
          userV2: {
            id: "shared-uuid",
            username: "shared-user",
            displayName: "Shared User",
            avatar: "https://example.test/avatar.jpg"
          }
        }
      });
    }

    if (url.startsWith("https://plex.tv/api/users")) {
      return xmlResponse(`
        <MediaContainer>
          <User id="1" username="owner" />
          <User id="2" username="friend" />
          <User id="3" username="shared-user" />
        </MediaContainer>
      `);
    }

    if (url === "https://plex.tv/users/account.json") {
      return jsonResponse({ user: { id: "1", uuid: "owner-uuid", username: "owner", title: "Owner" } });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const users = await plex.discoverUsers();

    assert.deepEqual(resolvedUsernames, ["shared-user"]);
    assert.deepEqual(users, [
      { plexUserId: "friend-uuid", username: "friend", displayName: "Friend", avatarUrl: null },
      {
        plexUserId: "shared-uuid",
        username: "shared-user",
        displayName: "Shared User",
        avatarUrl: "https://example.test/avatar.jpg"
      }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("discoverUsers keeps Community friends when the wider Plex account list is unavailable", async () => {
  const { logger, entries } = createCapturingLogger();
  const plex = new PlexIntegration(plexSettings, logger);
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith("https://community.plex.tv/api")) {
      const body = JSON.parse(String(init?.body)) as { query: string };
      assert.ok(body.query.includes("GetAllFriends"));
      return jsonResponse({
        data: {
          allFriendsV2: [{
            user: { id: "friend-uuid", username: "friend", displayName: "Friend", avatar: null }
          }]
        }
      });
    }

    if (url.startsWith("https://plex.tv/api/users")) {
      return xmlResponse("Unavailable", 503);
    }

    if (url === "https://plex.tv/users/account.json") {
      return jsonResponse({ user: { id: "1", uuid: "owner-uuid", username: "owner", title: "Owner" } });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const users = await plex.discoverUsers();

    assert.deepEqual(users, [
      { plexUserId: "friend-uuid", username: "friend", displayName: "Friend", avatarUrl: null }
    ]);
    assert.ok(entries.some((entry) => entry.level === "warn" && entry.message === "Could not discover shared Plex server users; using friends only"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
