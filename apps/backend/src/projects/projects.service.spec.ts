import { Test, TestingModule } from '@nestjs/testing';
import { ProjectsService } from './projects.service';
import { PrismaService } from '../prisma/prisma.service';
import * as fs from 'fs';
import * as path from 'path';

jest.mock('fs');

describe('ProjectsService — version-detection & flag generation', () => {
  let service: ProjectsService;

  const mockPrisma = {
    project: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
    instance: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
    $transaction: jest.fn(),
  };

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProjectsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<ProjectsService>(ProjectsService);
  });

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // readBuildVersion
  // ---------------------------------------------------------------------------

  describe('readBuildVersion', () => {
    const readBuildVersion = (buildRoot: string) =>
      (service as any).readBuildVersion(buildRoot) as { major: number; minor: number } | null;

    it('reads UE 5.4 from Build.version', () => {
      jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      jest.spyOn(fs, 'readFileSync').mockReturnValue(
        JSON.stringify({ MajorVersion: 5, MinorVersion: 4 }),
      );

      const result = readBuildVersion('/fake/build');
      expect(result).toEqual({ major: 5, minor: 4 });
    });

    it('reads UE 5.5 from Build.version', () => {
      jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      jest.spyOn(fs, 'readFileSync').mockReturnValue(
        JSON.stringify({ MajorVersion: 5, MinorVersion: 5 }),
      );

      const result = readBuildVersion('/fake/build');
      expect(result).toEqual({ major: 5, minor: 5 });
    });

    it('reads UE 5.6 from Build.version', () => {
      jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      jest.spyOn(fs, 'readFileSync').mockReturnValue(
        JSON.stringify({ MajorVersion: 5, MinorVersion: 6 }),
      );

      const result = readBuildVersion('/fake/build');
      expect(result).toEqual({ major: 5, minor: 6 });
    });

    it('reads UE 4.27 from Build.version', () => {
      jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      jest.spyOn(fs, 'readFileSync').mockReturnValue(
        JSON.stringify({ MajorVersion: 4, MinorVersion: 27 }),
      );

      const result = readBuildVersion('/fake/build');
      expect(result).toEqual({ major: 4, minor: 27 });
    });

    it('reads UE 6.0 from Build.version', () => {
      jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      jest.spyOn(fs, 'readFileSync').mockReturnValue(
        JSON.stringify({ MajorVersion: 6, MinorVersion: 0 }),
      );

      const result = readBuildVersion('/fake/build');
      expect(result).toEqual({ major: 6, minor: 0 });
    });

    it('returns null when Build.version is missing', () => {
      jest.spyOn(fs, 'existsSync').mockReturnValue(false);

      const result = readBuildVersion('/fake/build');
      expect(result).toBeNull();
    });

    it('returns null when Build.version is invalid JSON', () => {
      jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      jest.spyOn(fs, 'readFileSync').mockReturnValue('not json');

      const result = readBuildVersion('/fake/build');
      expect(result).toBeNull();
    });

    it('defaults missing MajorVersion/MinorVersion to 0', () => {
      jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      jest.spyOn(fs, 'readFileSync').mockReturnValue('{}');

      const result = readBuildVersion('/fake/build');
      expect(result).toEqual({ major: 0, minor: 0 });
    });
  });

  // ---------------------------------------------------------------------------
  // getPixelStreamingArgs
  // ---------------------------------------------------------------------------

  describe('getPixelStreamingArgs', () => {
    const getArgs = (port: number, version: { major: number; minor: number } | null) =>
      (service as any).getPixelStreamingArgs(port, version) as string[];

    it('returns single SignallingURL flag for UE 5.5', () => {
      const args = getArgs(8801, { major: 5, minor: 5 });
      expect(args).toEqual(['-PixelStreamingSignallingURL=ws://127.0.0.1:8801']);
    });

    it('returns single SignallingURL flag for UE 5.6', () => {
      const args = getArgs(8802, { major: 5, minor: 6 });
      expect(args).toEqual(['-PixelStreamingSignallingURL=ws://127.0.0.1:8802']);
    });

    it('returns single SignallingURL flag for UE 6.0', () => {
      const args = getArgs(8803, { major: 6, minor: 0 });
      expect(args).toEqual(['-PixelStreamingSignallingURL=ws://127.0.0.1:8803']);
    });

    it('returns IP+Port flags for UE 5.4', () => {
      const args = getArgs(8801, { major: 5, minor: 4 });
      expect(args).toEqual([
        '-PixelStreamingIP=127.0.0.1',
        '-PixelStreamingPort=8801',
      ]);
    });

    it('returns IP+Port flags for UE 5.3', () => {
      const args = getArgs(8801, { major: 5, minor: 3 });
      expect(args).toEqual([
        '-PixelStreamingIP=127.0.0.1',
        '-PixelStreamingPort=8801',
      ]);
    });

    it('returns IP+Port flags for UE 4.27', () => {
      const args = getArgs(8801, { major: 4, minor: 27 });
      expect(args).toEqual([
        '-PixelStreamingIP=127.0.0.1',
        '-PixelStreamingPort=8801',
      ]);
    });

    it('returns IP+Port flags when version is null (missing Build.version)', () => {
      const args = getArgs(8801, null);
      expect(args).toEqual([
        '-PixelStreamingIP=127.0.0.1',
        '-PixelStreamingPort=8801',
      ]);
    });

    it('returns IP+Port flags for UE 5.0', () => {
      const args = getArgs(8801, { major: 5, minor: 0 });
      expect(args).toEqual([
        '-PixelStreamingIP=127.0.0.1',
        '-PixelStreamingPort=8801',
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // findLauncherScript
  // ---------------------------------------------------------------------------

  describe('findLauncherScript', () => {
    const findScript = (buildRoot: string) =>
      (service as any).findLauncherScript(buildRoot) as string | null;

    it('finds .sh launcher script on Linux', () => {
      jest.spyOn(fs, 'readdirSync').mockReturnValue([
        { name: 'ArchVizExplorer.sh', isFile: () => true, isDirectory: () => false } as any,
      ]);

      const result = findScript('/fake/build');
      if ((service as any).isLinux) {
        expect(result).toBe(path.join('/fake/build', 'ArchVizExplorer.sh'));
      } else {
        expect(result).toBeNull();
      }
    });

    it('finds .bat launcher script on Windows', () => {
      jest.spyOn(fs, 'readdirSync').mockReturnValue([
        { name: 'ArchVizExplorer.bat', isFile: () => true, isDirectory: () => false } as any,
      ]);

      const result = findScript('/fake/build');
      if (!(service as any).isLinux) {
        expect(result).toBe(path.join('/fake/build', 'ArchVizExplorer.bat'));
      } else {
        expect(result).toBeNull();
      }
    });

    it('finds .sh in subdirectory when not at root', () => {
      jest.spyOn(fs, 'readdirSync')
        .mockReturnValueOnce([
          { name: 'MyProject', isFile: () => false, isDirectory: () => true } as any,
        ])
        .mockReturnValueOnce([
          { name: 'MyProject.sh', isFile: () => true, isDirectory: () => false } as any,
        ]);

      const result = findScript('/fake/build');
      if ((service as any).isLinux) {
        expect(result).toBe(path.join('/fake/build', 'MyProject', 'MyProject.sh'));
      } else {
        expect(result).toBeNull();
      }
    });

    it('skips Engine/ and Build/ subdirectories', () => {
      jest.spyOn(fs, 'readdirSync').mockReturnValue([
        { name: 'Engine', isFile: () => false, isDirectory: () => true } as any,
        { name: 'Build', isFile: () => false, isDirectory: () => true } as any,
      ]);

      const result = findScript('/fake/build');
      expect(result).toBeNull();
    });

    it('skips excluded scripts like Build.sh', () => {
      jest.spyOn(fs, 'readdirSync').mockReturnValue([
        { name: 'Build.sh', isFile: () => true, isDirectory: () => false } as any,
      ]);

      const result = findScript('/fake/build');
      expect(result).toBeNull();
    });

    it('returns null when no launcher scripts exist', () => {
      jest.spyOn(fs, 'readdirSync').mockReturnValue([
        { name: 'Manifest.txt', isFile: () => true, isDirectory: () => false } as any,
      ]);

      const result = findScript('/fake/build');
      expect(result).toBeNull();
    });

    it('returns null when directory read fails', () => {
      jest.spyOn(fs, 'readdirSync').mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const result = findScript('/fake/build');
      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // prepareUEDirectories
  // ---------------------------------------------------------------------------

  describe('prepareUEDirectories', () => {
    it('creates Saved/Logs and Config directories', () => {
      jest.spyOn(fs, 'existsSync').mockReturnValue(false);
      const mkdirSyncSpy = jest.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);

      (service as any).prepareUEDirectories('/fake/build');

      expect(mkdirSyncSpy).toHaveBeenCalledWith(
        path.join('/fake/build', 'Saved', 'Logs'),
        { recursive: true },
      );
      expect(mkdirSyncSpy).toHaveBeenCalledWith(
        path.join('/fake/build', 'Config'),
        { recursive: true },
      );
      expect(mkdirSyncSpy).toHaveBeenCalledWith(
        path.join('/fake/build', 'Saved'),
        { recursive: true },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // getUEEnvironment
  // ---------------------------------------------------------------------------

  describe('getUEEnvironment', () => {
    it('returns Vulkan/Mesa env vars on Linux', () => {
      // Mock existsSync to return true for ICD path check
      jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      const env = (service as any).getUEEnvironment();
      // Service may be on any platform, but the method checks this.isLinux
      if ((service as any).isLinux) {
        expect(env).toHaveProperty('VK_ICD_FILENAMES');
        expect(env).toHaveProperty('GALLIUM_DRIVER', 'llvmpipe');
        expect(env).toHaveProperty('MESA_GL_VERSION_OVERRIDE', '4.5');
        expect(env).toHaveProperty('XDG_RUNTIME_DIR');
      } else {
        expect(env).toEqual({});
      }
    });

    it('auto-detects Vulkan ICD when default path missing', () => {
      jest.spyOn(fs, 'existsSync')
        .mockReturnValueOnce(false) // default ICD path doesn't exist
        .mockReturnValueOnce(true); // /usr/share/vulkan/icd.d exists
      jest.spyOn(fs, 'readdirSync').mockReturnValue(['lvp_icd_x86_64.json'] as any);

      const env = (service as any).getUEEnvironment();
      if ((service as any).isLinux) {
        expect(env.VK_ICD_FILENAMES).toBe('/usr/share/vulkan/icd.d/lvp_icd_x86_64.json');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // PixelStreaming flag edge cases — full launch argument composition
  // ---------------------------------------------------------------------------

  describe('PixelStreaming flag composition', () => {
    const getArgs = (port: number, version: { major: number; minor: number } | null) =>
      (service as any).getPixelStreamingArgs(port, version) as string[];

    it('UE 5.5+ uses single SignallingURL with correct port', () => {
      const args = getArgs(8801, { major: 5, minor: 5 });
      expect(args).toHaveLength(1);
      expect(args[0]).toContain('8801');
    });

    it('UE < 5.5 uses IP+Port with correct port', () => {
      const args = getArgs(9000, { major: 5, minor: 4 });
      expect(args).toHaveLength(2);
      expect(args[0]).toContain('127.0.0.1');
      expect(args[1]).toContain('9000');
    });

    it('future UE 7.0 uses SignallingURL (>= 5.5 rule)', () => {
      const args = getArgs(8801, { major: 7, minor: 0 });
      expect(args).toEqual(['-PixelStreamingSignallingURL=ws://127.0.0.1:8801']);
    });

    it('null version defaults to safe IP+Port fallback', () => {
      const args = getArgs(8801, null);
      expect(args).toHaveLength(2);
    });
  });
});
