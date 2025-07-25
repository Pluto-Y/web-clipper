import localeService from '@/common/locales';
import { ICookieService } from '@/service/common/cookie';
import { IWebRequestService } from '@/service/common/webRequest';
import { generateUuid } from '@web-clipper/shared/lib/uuid';
import axios, { AxiosInstance } from 'axios';
import Container from 'typedi';
import { CreateDocumentRequest, DocumentService } from '../../index';
import { CompleteStatus, UnauthorizedError } from './../interface';
import { NotionRepository, NotionUserContent, RecentPages } from './types';

const PAGE = 'page';
const COLLECTION_VIEW_PAGE = 'collection_view_page';
const origin = 'https://www.notion.so/';

export default class NotionDocumentService implements DocumentService {
  private request: AxiosInstance;
  private repositories: NotionRepository[];
  private userContent?: NotionUserContent;
  private webRequestService: IWebRequestService;
  private cookieService: ICookieService;

  constructor() {
    const request = axios.create({
      baseURL: origin,
      timeout: 10000,
      transformResponse: [
        (data): any => {
          return JSON.parse(data);
        },
      ],
      withCredentials: true,
    });
    this.request = request;
    this.repositories = [];
    this.webRequestService = Container.get(IWebRequestService);
    this.cookieService = Container.get(ICookieService);
    this.request.interceptors.response.use(
      (r) => r,
      (error) => {
        if (error.response && error.response.status === 401) {
          return Promise.reject(
            new UnauthorizedError(
              localeService.format({
                id: 'backend.services.notion.unauthorizedErrorMessage',
                defaultMessage: 'Unauthorized! Please Login Notion Web.',
              })
            )
          );
        }
        return Promise.reject(error);
      }
    );
  }

  getId = () => {
    return 'notion';
  };

  getUserInfo = async () => {
    if (!this.userContent) {
      this.userContent = await this.getUserContent();
    }
    const user = this.userContent.recordMap.notion_user;
    const userInfo = Object.values(user)[0];
    const { email, profile_photo, name } = userInfo.value;
    return {
      name,
      avatar: profile_photo,
      homePage: 'https://www.notion.so/',
      description: email,
    };
  };

  getRepositories = async () => {
    if (!this.userContent) {
      this.userContent = await this.getUserContent();
    }

    const userId = Object.keys(this.userContent.recordMap.notion_user)[0] as string;
    const spaces = (await this.getSpaces(userId)) as any;
    const result: Array<NotionRepository[]> = await Promise.all(
      Object.keys(spaces).map(async (p) => {
        const space = spaces[p];
        const recentPages = await this.getRecentPageVisits(space.spaceId, userId);
        const spaceName = await this.getSpaceName(space.spaceId);
        return this.loadSpace(space.spaceId, spaceName, recentPages);
      })
    );

    this.repositories = result.flat() as NotionRepository[];
    return this.repositories;
  };

  getSpaces = async (userId: string) => {
    const response = await this.requestWithCookie.post<{
      users: {
        [id: string]: {
          user_root: {
            [id: string]: {
              value: {
                space_view_pointers: [
                  {
                    id: string;
                    table: string;
                    spaceId: string;
                  }
                ]
              }
            };
          }
          space: any;
        };
      };
    }>('/api/v3/getSpacesInitial');
    return response.data.users[userId].user_root[userId].value.space_view_pointers;
  };

  getSpaceName = async (spaceId: string) => {
    const response = await this.requestWithCookie.post<{
      results: [
        {
          name: string;
        }
      ]
    }>('api/v3/getPublicSpaceData', {
      spaceIds: [spaceId],
      type: 'space-ids'
    });
    return response.data.results[0].name;
  }

  createDocument = async ({
    repositoryId,
    title,
    content,
  }: CreateDocumentRequest): Promise<CompleteStatus> => {
    let fileName = `${title}.md`;

    const repository = this.repositories.find((o) => o.id === repositoryId);
    if (!repository) {
      throw new Error('Illegal repository');
    }

    const documentId = await this.createEmptyFile(repository, content);
    const fileUrl = await this.getFileUrl(encodeURI(fileName));
    await axios.put(fileUrl.signedPutUrl, `${content}`, {
      headers: {
        'Content-Type': 'text/markdown',
      },
    });
    if (!this.userContent) {
      this.userContent = await this.getUserContent();
    }
    const spaceId = await this.getSpaceId();
    await this.requestWithCookie.post('api/v3/enqueueTask', {
      task: {
        eventName: 'importFile',
        request: {
          fileURL: fileUrl.url,
          fileName,
          importType: 'ReplaceBlock',
          block: {
            id: documentId,
            spaceId: spaceId,
          },
          spaceId: spaceId,
        },
      },
    });

    return {
      href: `https://www.notion.so/${repository.groupId}/${documentId.replace(/-/g, '')}`,
    };
  };

  getSpaceId = async () => {
    if (!this.userContent) {
      this.userContent = await this.getUserContent();
    }

    const userId = Object.keys(this.userContent.recordMap.notion_user)[0] as string;
    const spaces = (await this.getSpaces(userId)) as any;
    return spaces[0].spaceId;
  };

  createEmptyFile = async (repository: NotionRepository, title: string) => {
    if (!this.userContent) {
      this.userContent = await this.getUserContent();
    }
    const spaceId = await this.getSpaceId();
    const documentId = generateUuid();
    const requestId = generateUuid();
    const inner_requestId = generateUuid();
    const parentId = repository.id;
    const userId = Object.values(this.userContent.recordMap.notion_user)[0].value.id;
    const time = new Date().getDate();
    let operations;
    if (repository.pageType === PAGE) {
      operations = [
        {
          id: documentId,
          table: 'block',
          path: [],
          command: 'set',
          args: {
            type: 'page',
            id: documentId,
            space_id: spaceId,
            version: 1,
          },
        },
        {
          id: documentId,
          table: 'block',
          path: [],
          command: 'update',
          args: {
            parent_id: parentId,
            parent_table: 'block',
            alive: true,
            space_id: spaceId,
          },
        },
        {
          table: 'block',
          id: parentId,
          path: ['content'],
          command: 'listAfter',
          args: {
            id: documentId,
            space_id: spaceId,
          },
        },
        {
          id: documentId,
          table: 'block',
          path: [],
          command: 'update',
          args: {
            created_by: userId,
            created_time: time,
            last_edited_time: time,
            last_edited_by: userId,
            space_id: spaceId,
          },
        },
        {
          id: parentId,
          table: 'block',
          path: [],
          command: 'update',
          args: {
            last_edited_time: time,
            space_id: spaceId,
          },
        },
        {
          id: documentId,
          table: 'block',
          path: ['properties', 'title'],
          command: 'set',
          args: [[title]],
        },
        {
          id: documentId,
          table: 'block',
          path: [],
          command: 'update',
          args: {
            last_edited_time: time,
            space_id: spaceId,
          },
        },
      ];
    } else if (repository.pageType === COLLECTION_VIEW_PAGE) {
      operations = [
        {
          id: documentId,
          table: 'block',
          path: [],
          command: 'set',
          args: {
            type: 'page',
            id: documentId,
            space_id: spaceId,
            version: 1,
          },
        },
        {
          id: documentId,
          table: 'block',
          path: [],
          command: 'update',
          args: {
            parent_id: parentId,
            parent_table: 'collection',
            space_id: spaceId,
            alive: true,
          },
        },
      ];
    }

    await this.requestWithCookie.post('api/v3/saveTransactionsFanout', {
      requestId: requestId,
      transactions: [
        {
          id: inner_requestId,
          operations: operations,
          spaceId: spaceId,
        }
      ]
    });
    return documentId;
  };

  getFileUrl = async (fileName: string) => {
    const result = await this.requestWithCookie.post<{
      url: string;
      signedPutUrl: string;
    }>('api/v3/getUploadFileUrl', {
      bucket: 'temporary',
      name: fileName,
      contentType: 'text/markdown',
    });
    return result.data;
  };

  private async loadSpace(
    spaceId: string,
    spaceName: string,
    recentPages: RecentPages
  ): Promise<NotionRepository[]> {
    const response = await this.requestWithCookie.post<{
      pages: string[];
      recordMap: {
        block: {
          [id: string]: {
            value: {
              collection_id: string;
              id: string;
              type: string;
              space_id: string;
              properties: {
                title: string[];
              };
            };
          };
        };
      };
    }>('api/v3/getUserSharedPagesInSpace', {
      includeDeleted: false,
      includeTeamSharedPages: false,
      spaceId,
    });

    const pages: string[] = response.data.pages as string[];

    return pages
      .map((pageId): NotionRepository | null => {
        const value = response.data.recordMap.block[pageId]!.value;
        if (value.type === PAGE && !!value.properties && !!value.properties.title) {
          return {
            id: value.id,
            name: value.properties.title.toString(),
            groupId: spaceId,
            groupName: spaceName,
            pageType: PAGE,
          };
        }
        const collections = recentPages.recordMap.collection;
        if (
          value.type === COLLECTION_VIEW_PAGE &&
          !!value.collection_id &&
          !!collections &&
          !!collections[value.collection_id] &&
          !!collections[value.collection_id].value &&
          !!collections[value.collection_id].value.name
        ) {
          return {
            id: collections[value.collection_id].value.id,
            name: collections[value.collection_id].value.name.toString(),
            groupId: spaceId,
            groupName: spaceName,
            pageType: COLLECTION_VIEW_PAGE,
          };
        }
        return null;
      })
      .filter((p): p is NotionRepository => !!p);
  }

  private async getRecentPageVisits(spaceId: string, userId: string): Promise<RecentPages> {
    const res = await this.requestWithCookie.post<RecentPages>('api/v3/getRecentPageVisits', {
      spaceId,
      userId,
    });
    return res.data;
  }

  private getUserContent = async () => {
    const response = await this.requestWithCookie.post<NotionUserContent>('api/v3/loadUserContent');
    return response.data;
  };

  /**
   * Modify the cookie when request
   */
  private get requestWithCookie() {
    const post = async <T>(url: string, data?: any) => {
      const cookies = await this.cookieService.getAll({
        url: origin,
      });
      const cookieString = cookies.map((o) => `${o.name}=${o.value}`).join(';');
      const header = await this.webRequestService.startChangeHeader({
        urls: [`${origin}*`],
        requestHeaders: [
          {
            name: 'cookie',
            value: cookieString,
          },
          {
            name: `Content-Type`,
            value: 'application/json',
          },
        ],
      });
      try {
        const result = await this.request.post<T>(
          await this.webRequestService.changeUrl(url, header),
          data,
          {}
        );
        await this.webRequestService.end(header);
        return result;
      } catch (error) {
        await this.webRequestService.end(header);
        throw error;
      }
    };
    return {
      post,
    };
  }
}
