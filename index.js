import fs from "fs";
import { Client } from "@notionhq/client";
import { config } from "dotenv";
import { markdownToBlocks } from "@tryfabric/martian";

config();

const notion = new Client({ auth: process.env.NOTION_KEY });
const databaseId = process.env.NOTION_DATABASE_ID;

async function createPage(title, tag) {
  const response = await notion.pages.create({
    parent: { database_id: databaseId },
    properties: {
      Tags: {
        type: "multi_select",
        multi_select: [
          {
            name: tag,
          },
          {
            name: "repo doc",
          },
        ],
      },
      title: {
        title: [
          {
            text: {
              content: title,
            },
          },
        ],
      },
    },
  });
  return response.id;
}

// Pulls db entries with the same tags as the files. tag is derived from parent file name
async function getPages(tag) {
  const filter = {
    property: "Tags",
    multi_select: {
      contains: tag,
    },
  };

  const query = {
    database_id: databaseId,
    filter,
  };

  const response = await notion.databases.query(query);
  return response.results.map((page) => {
    return {
      title: page.properties.Name.title[0].text.content,
      id: page.id,
    };
  });
}

function parseTags(files) {
  const tags = {};

  for (let i = 0; i < files.length; i++) {
    const splitFile = files[i].split("/");
    for (let j = 0; j < splitFile.length - 1; j++) {
      if (splitFile[j + 1].includes(".")) {
        //tags.add(splitFile[j]);
        if (tags[splitFile[j]]) {
          tags[splitFile[j]].push(files[i]);
        } else {
          tags[splitFile[j]] = [files[i]];
        }
      }
    }
  }

  return tags;
}

async function getPageBlocks(pageId) {
  const response = await notion.blocks.children.list({
    block_id: pageId,
    page_size: 50,
  });
  return response.results.map((block) => block.id);
}

async function deleteBlocks(blockIds) {
  if (blockIds.length === 0) return;
  await blockIds.forEach(async (blockId, index) => {
    // Notion api limits 3 requests per second
    if (index % 3 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    await notion.blocks
      .delete({
        block_id: blockId,
      })
      .then(() => console.log("Deleted block: " + blockId))
      .catch((err) => console.error("Error Deleting blocks"));
  });
  return;
}

async function uploadBlocks(pageId, blocks) {
  console.log("Uploading blocks...");
  const response = await notion.blocks.children
    .append({
      block_id: pageId,
      children: [...blocks],
    })
    .catch((err) => console.error(err));
}

// notion will reject relative paths as an invalid url
function removeLinksFromMarkdown(markdown) {
  // Regular expression pattern to match links in markdown format
  var linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;

  // Remove links from the markdown string
  var plainText = markdown.replace(linkRegex, (_match, linkText, _linkUrl) => {
    return linkText;
  });

  return plainText;
}

async function uploadDocs(tags) {
  Object.keys(tags).forEach(async (tag) => {
    const pages = await getPages(tag);
    // for each file in the tag, check if it exists in the db
    tags[tag].forEach(async (file) => {
      const fileName = file.split("/").pop().split(".")[0];
      const pageId = pages.find((page) => page.title === fileName)?.id;
      const fileContents = fs.readFileSync(file, "utf8");
      const parsedPageBlocks = markdownToBlocks(
        removeLinksFromMarkdown(fileContents)
      );
      if (pageId) {
        console.log("Updating page: " + fileName, pageId, tag);
        const pageBlockIds = await getPageBlocks(pageId).catch((err) =>
          console.error("Error getting page blocks: " + err)
        );

        await deleteBlocks(pageBlockIds).then(async () => {
          await uploadBlocks(pageId, parsedPageBlocks);
        });
      } else {
        console.log("Creating page: " + fileName, tag);
        await createPage(fileName, tag).then((pageId) => {
          console.log("Created page: " + fileName, pageId, tag);
          uploadBlocks(pageId, parsedPageBlocks).catch((err) =>
            console.error("Error uploading blocks: ", err)
          );
        });
      }
    });
  });
}

async function main() {
  const updatedFiles = process.argv.slice(2);
  const tags = parseTags(updatedFiles);

  uploadDocs(tags).catch((err) => console.error(err));
}

main();
