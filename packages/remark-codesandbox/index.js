const visit = require('unist-util-visit');
const is = require('unist-util-is');
const toString = require('mdast-util-to-string');
const u = require('unist-builder');
const { getParameters } = require('codesandbox/lib/api/define');
const got = require('got');

const CUSTOM_TEMPLATES = {
  react: {
    extends: 'new',
  },
  'react-component': {
    extends: 'new',
    entry: 'src/App.js',
  },
};

const cachedTemplates = new Map();

async function getTemplate(templateID) {
  if (cachedTemplates.has(templateID)) {
    return cachedTemplates.get(templateID);
  }

  const baseTemplateID = CUSTOM_TEMPLATES[templateID]
    ? CUSTOM_TEMPLATES[templateID].extends
    : templateID;

  if (cachedTemplates.has(baseTemplateID)) {
    const template = {
      ...cachedTemplates.get(baseTemplateID),
      ...(CUSTOM_TEMPLATES[templateID] || {}),
    };

    cachedTemplates.set(templateID, template);
    return template;
  }

  const { data } = await got(
    `https://codesandbox.io/api/v1/sandboxes/${baseTemplateID}`
  ).json();

  const template = {
    ...data,
    ...(CUSTOM_TEMPLATES[templateID] || {}),
  };

  // Construct files/directories mappings
  const mappings = {};

  template.directories.forEach(dir => {
    mappings[dir.shortid] = dir;
  });
  template.modules.forEach(file => {
    mappings[file.shortid] = file;
  });

  function getFilePath(shortid) {
    const dir = mappings[shortid];

    if (!dir) {
      return null;
    }

    return [getFilePath(dir.directory_shortid), dir.title]
      .filter(Boolean)
      .join('/');
  }

  // Construct files mappings
  const files = {};

  template.modules.forEach(file => {
    const path = getFilePath(file.shortid);

    files[path] = { content: file.code };
  });

  template.files = files;

  cachedTemplates.set(templateID, template);

  return template;
}

function codesandbox({ mode = 'meta' } = {}) {
  return async function transformer(tree) {
    let title;
    const codes = [];

    visit(tree, (node, index, parent) => {
      if (!title && is(node, ['heading', { depth: 1 }])) {
        title = toString(node);
      } else if (is(node, 'code')) {
        codes.push([node, index, parent]);
      }
    });

    for (const [node, _, parent] of codes) {
      const meta = parseMeta(node.meta);
      const sandboxMeta = meta.codesandbox;

      if (!sandboxMeta) {
        continue;
      }

      const [templateID, queryString] = sandboxMeta.split('?');
      const query = new URLSearchParams(queryString);

      const template = await getTemplate(templateID);

      template.title = title || template.title;

      if (!query.has('module')) {
        query.set('module', template.entry);
      }

      const parameters = getParameters({
        files: {
          ...template.files,
          [template.entry]: { content: node.value },
        },
      });

      const { sandbox_id } = await got
        .post('https://codesandbox.io/api/v1/sandboxes/define', {
          json: {
            parameters,
            json: 1,
          },
        })
        .json();

      const url = `https://codesandbox.io/s/${sandbox_id}?${query.toString()}`;

      switch (mode) {
        case 'button': {
          const button = u('paragraph', [
            u('link', { url }, [
              u('image', {
                url: 'https://codesandbox.io/static/img/play-codesandbox.svg',
                alt: 'Edit on CodeSandbox',
              }),
            ]),
          ]);

          const index = parent.children.indexOf(node);
          parent.children.splice(index + 1, 0, button);

          break;
        }
        case 'iframe': {
          const iframeQuery = new URLSearchParams({
            fontsize: '14px',
            hidenavigation: 1,
            theme: 'dark',
          });
          query.forEach((value, key) => {
            iframeQuery.set(key, value);
          });

          const iframe = u('html', {
            value: `<iframe
  src="https://codesandbox.io/embed/${sandbox_id}?${iframeQuery.toString()}"
  style="width:100%; height:500px; border:0; border-radius: 4px; overflow:hidden;"
  title="${template.title || ''}"
  allow="geolocation; microphone; camera; midi; vr; accelerometer; gyroscope; payment; ambient-light-sensor; encrypted-media; usb"
  sandbox="allow-modals allow-forms allow-popups allow-scripts allow-same-origin"
></iframe>`,
          });

          const index = parent.children.indexOf(node);
          parent.children.splice(index, 1, iframe);

          break;
        }
        case 'meta':
        default: {
          node.data = node.data || {};
          node.data.hProperties = node.data.hProperties || {};

          node.data.codesandboxUrl = url;
          node.data.hProperties.dataCodesandboxUrl = url;

          break;
        }
      }
    }
  };
}

function parseMeta(metaString) {
  const meta = {};

  metaString.split(' ').forEach(str => {
    const [key, value] = str.split('=');

    meta[key] = value;
  });

  return meta;
}

module.exports = codesandbox;
