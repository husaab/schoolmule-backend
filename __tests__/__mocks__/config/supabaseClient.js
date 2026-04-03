// Mock Supabase client - storage only (schoolmule does NOT use Supabase Auth)

const mockUpload = jest.fn().mockResolvedValue({ data: { path: 'mock-path' }, error: null });
const mockRemove = jest.fn().mockResolvedValue({ data: {}, error: null });
const mockCreateSignedUrl = jest.fn().mockResolvedValue({ data: { signedUrl: 'https://mock-signed-url.com' }, error: null });
const mockDownload = jest.fn().mockResolvedValue({ data: null, error: { message: 'Not configured' } });
const mockGetPublicUrl = jest.fn().mockReturnValue({ data: { publicUrl: 'https://mock-public-url.com' } });
const mockList = jest.fn().mockResolvedValue({ data: [], error: null });

const mockBucket = {
  upload: mockUpload,
  remove: mockRemove,
  createSignedUrl: mockCreateSignedUrl,
  download: mockDownload,
  getPublicUrl: mockGetPublicUrl,
  list: mockList,
};

const supabase = {
  storage: {
    from: jest.fn().mockReturnValue(mockBucket),
  },
  _mockStorage: mockBucket,
  _reset() {
    mockUpload.mockReset().mockResolvedValue({ data: { path: 'mock-path' }, error: null });
    mockRemove.mockReset().mockResolvedValue({ data: {}, error: null });
    mockCreateSignedUrl.mockReset().mockResolvedValue({ data: { signedUrl: 'https://mock-signed-url.com' }, error: null });
    mockDownload.mockReset().mockResolvedValue({ data: null, error: { message: 'Not configured' } });
    mockGetPublicUrl.mockReset().mockReturnValue({ data: { publicUrl: 'https://mock-public-url.com' } });
    mockList.mockReset().mockResolvedValue({ data: [], error: null });
    this.storage.from.mockReturnValue(mockBucket);
  },
};

module.exports = supabase;
