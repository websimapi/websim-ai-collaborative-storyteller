import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { WebsimSocket, useQuery } from '@websim/use-query';
import { create } from 'zustand';

// --- Zustand Store for Global UI State ---
const useUIStore = create(set => ({
  viewMode: 'loading', // 'loading', 'story', 'gallery', 'finishedStoryView'
  selectedStoryForView: null,
  isLoadingGlobal: false, // For major operations like starting/finishing story
  isLoadingPageGeneration: false, // For LLM/image generation
  activeStoryIdFromRoom: null, // Initialize activeStoryIdFromRoom
  setViewMode: (mode) => set({ viewMode: mode }),
  setSelectedStoryForView: (story) => set({ selectedStoryForView: story }),
  setIsLoadingGlobal: (loading) => set({ isLoadingGlobal: loading }),
  setIsLoadingPageGeneration: (loading) => set({ isLoadingPageGeneration: loading }),
}));

// --- Websim Room Initialization ---
const room = new WebsimSocket({
  schema: {
    stories: {
      id: "uuid",
      title: "text",
      status: "text", // 'active', 'finished'
      created_by_user_id: "uuid",
      last_updated_by_user_id: "uuid",
    },
    story_pages: {
      id: "uuid",
      story_id: "uuid",
      page_number: "integer",
      illustration_url: "text",
      generated_at: "timestamptz",
      original_comment_text: "text",
      original_comment_author_id: "uuid",
      original_comment_author_username: "text", // For easier display in active story
      original_comment_created_at: "timestamptz",
      ai_script_prompt: "text",
      ai_page_narrative: "text",
    }
  }
});

// --- Helper Functions ---
const generateUUID = () => crypto.randomUUID();
const getSortedPages = (pagesObject) => {
  if (!pagesObject || typeof pagesObject !== 'object') return [];
  return Object.values(pagesObject).sort((a, b) => a.page_number - b.page_number);
};

// --- React Components ---

function UserAvatar({ userId, username }) {
  // In a real app, you might fetch avatar URLs or rely on room.peers if user is active
  // For now, just display username
  if (!username && userId) {
    // Potentially fetch username if needed, but for now, keep it simple
    // This part can be enhanced if we have a global user cache
    const [fetchedUsername, setFetchedUsername] = useState('');
    useEffect(() => {
      // Placeholder: In a real app, you'd have a way to get user details by ID
      // For now, if room.peers has this user, use it
      const peer = room.peers && Object.values(room.peers).find(p => p.id === userId);
      if (peer) {
        setFetchedUsername(peer.username);
      } else {
         // Fallback or fetch from a user service if available
         // For simplicity, if not in peers, it might be an older user.
         // The `original_comment_author_username` on the page object itself is preferred.
      }
    }, [userId]);
    return <span className="font-semibold">{username || fetchedUsername || 'A user'}</span>;
  }
  return <span className="font-semibold">{username || 'A user'}</span>;
}


function PageViewer({ page }) {
  if (!page) return <div className="text-center text-gray-500">Select a page or start the story!</div>;

  return (
    <div className="page-viewer p-6 bg-white shadow-xl rounded-lg">
      <h3 className="text-2xl font-bold mb-4">Page {page.page_number + 1}</h3>
      {page.illustration_url && (
        <img src={page.illustration_url} alt={`Illustration for page ${page.page_number + 1}`} className="w-full h-auto object-contain rounded-md mb-4 max-h-96" />
      )}
      <p className="text-lg text-gray-800 mb-4 whitespace-pre-wrap">{page.ai_page_narrative}</p>
      <div className="text-xs text-gray-500 mt-4 pt-4 border-t">
        <p>Inspired by: "{page.original_comment_text}"</p>
        <p>Suggested by: <UserAvatar userId={page.original_comment_author_id} username={page.original_comment_author_username} /> at {new Date(page.original_comment_created_at).toLocaleString()}</p>
        <p>Page generated at: {new Date(page.generated_at).toLocaleString()}</p>
      </div>
    </div>
  );
}

function StoryWorkspace({ activeStoryId, activeStoryPages }) {
  const { setIsLoadingPageGeneration, isLoadingPageGeneration, setViewMode } = useUIStore();
  const [currentUser, setCurrentUser] = useState(null);
  const [comment, setComment] = useState('');
  const [currentPageIndex, setCurrentPageIndex] = useState(0);

  const sortedPages = useMemo(() => getSortedPages(activeStoryPages), [activeStoryPages]);

  useEffect(() => {
    window.websim.getCurrentUser().then(setCurrentUser);
  }, []);

  useEffect(() => {
    // When pages update, set current page to the last page
    if (sortedPages.length > 0) {
      setCurrentPageIndex(sortedPages.length - 1);
    } else {
      setCurrentPageIndex(0);
    }
  }, [sortedPages.length]);

  const handleAddPage = async () => {
    if (!comment.trim() || !currentUser || !activeStoryId || isLoadingPageGeneration) return;
    setIsLoadingPageGeneration(true);

    try {
      const storyContext = sortedPages.map(p => p.ai_page_narrative).join("\n\n---\n\n");
      const fullPrompt = `Previous story context:\n${storyContext}\n\nUser's idea for next part: "${comment}"\n\nGenerate a narrative for the next page and a concise DALL-E style prompt for an illustration for this narrative. Respond ONLY with a JSON object with keys "narrative" and "illustration_prompt".`;
      
      const llmResponse = await websim.chat.completions.create({
        messages: [
          { role: "system", content: "You are a creative storyteller. Follow the user's JSON format instruction precisely." },
          { role: "user", content: fullPrompt }
        ],
        json: true,
      });

      const { narrative, illustration_prompt } = JSON.parse(llmResponse.content);

      if (!narrative || !illustration_prompt) {
        throw new Error("LLM did not return expected data.");
      }
      
      const imageResult = await websim.imageGen({ prompt: illustration_prompt, aspect_ratio: "16:9" });
      if (!imageResult || !imageResult.url) {
        throw new Error("Failed to generate image.");
      }

      const newPageId = generateUUID();
      const newPageNumber = sortedPages.length;

      const newPage = {
        id: newPageId,
        story_id: activeStoryId,
        page_number: newPageNumber,
        illustration_url: imageResult.url,
        generated_at: new Date().toISOString(),
        original_comment_text: comment,
        original_comment_author_id: currentUser.id,
        original_comment_author_username: currentUser.username,
        original_comment_created_at: new Date().toISOString(),
        ai_script_prompt: illustration_prompt,
        ai_page_narrative: narrative,
      };
      
      // Update roomState: add the new page
      const updatedPages = { ...(activeStoryPages || {}), [newPageId]: newPage };
      await room.updateRoomState({ activeStoryPages: updatedPages });
      
      setComment('');
      // setCurrentPageIndex will be updated by useEffect listening to sortedPages.length
    } catch (error) {
      console.error("Error adding page:", error);
      alert(`Failed to add page: ${error.message}`);
    } finally {
      setIsLoadingPageGeneration(false);
    }
  };

  const handleFinishStory = async () => {
    if (!activeStoryId || sortedPages.length === 0) {
      alert("No story to finish or story is empty.");
      return;
    }
    useUIStore.getState().setIsLoadingGlobal(true);
    try {
      for (const page of sortedPages) {
        await room.collection('story_pages').upsert(page);
      }
      await room.collection('stories').upsert({ 
        id: activeStoryId, 
        status: 'finished',
        last_updated_by_user_id: currentUser?.id 
      });
      await room.updateRoomState({ activeStoryId: null, activeStoryPages: null });
      setViewMode('gallery'); // Navigate to gallery after finishing
    } catch (error) {
      console.error("Error finishing story:", error);
      alert(`Failed to finish story: ${error.message}`);
    } finally {
      useUIStore.getState().setIsLoadingGlobal(false);
    }
  };

  if (!activeStoryId) {
    return <div className="text-center p-5">No active story. Go to Gallery to start or continue one.</div>;
  }

  return (
    <div className="container mx-auto p-4">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-3xl font-bold">Active Story colaboración</h2>
        <button onClick={() => setViewMode('gallery')} className="button button-secondary">View Gallery</button>
      </div>

      {sortedPages.length > 0 && (
        <>
          <PageViewer page={sortedPages[currentPageIndex]} />
          <div className="flex justify-between items-center my-4">
            <button
              onClick={() => setCurrentPageIndex(prev => Math.max(0, prev - 1))}
              disabled={currentPageIndex === 0}
              className="button button-primary"
            >
              Previous
            </button>
            <span className="text-gray-700">Page {currentPageIndex + 1} of {sortedPages.length}</span>
            <button
              onClick={() => setCurrentPageIndex(prev => Math.min(sortedPages.length - 1, prev + 1))}
              disabled={currentPageIndex === sortedPages.length - 1}
              className="button button-primary"
            >
              Next
            </button>
          </div>
        </>
      )}
      {sortedPages.length === 0 && <p className="text-center text-gray-500 my-8">This story is empty. Add the first page!</p>}

      <div className="mt-6 p-4 bg-gray-100 rounded-lg shadow">
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Your idea for the next part of the story..."
          className="w-full p-2 border rounded mb-2 h-24"
          disabled={isLoadingPageGeneration}
        />
        <button
          onClick={handleAddPage}
          disabled={isLoadingPageGeneration || !comment.trim()}
          className="button button-primary w-full"
        >
          {isLoadingPageGeneration ? <div className="spinner mx-auto" style={{width: '20px', height: '20px', borderColor: 'white', borderLeftColor: 'transparent'}}></div> : 'Add to Story'}
        </button>
      </div>

      {sortedPages.length > 0 && (
        <button
          onClick={handleFinishStory}
          className="button button-danger w-full mt-6"
          disabled={isLoadingPageGeneration}
        >
          Finish Story & Save to Gallery
        </button>
      )}
    </div>
  );
}

function StoryGallery() {
  const { setViewMode, setSelectedStoryForView, setIsLoadingGlobal } = useUIStore();
  const activeStoryIdFromStore = useUIStore(state => state.activeStoryIdFromRoom); // Subscribe to activeStoryIdFromRoom

  const { data: storiesData, loading: storiesLoading } = useQuery(
    room.collection('stories').filter({ status: 'finished' }) // Or query all and filter client-side if status filter not robust
  );
  const [currentUser, setCurrentUser] = useState(null);

  useEffect(() => {
    window.websim.getCurrentUser().then(setCurrentUser);
  }, []);
  
  const finishedStories = useMemo(() => {
      return (storiesData || []).filter(s => s.status === 'finished');
  }, [storiesData]);


  const handleStartNewStory = async () => {
    if (!currentUser) {
      alert("User not loaded yet.");
      return;
    }
    setIsLoadingGlobal(true);
    try {
      const newStoryId = generateUUID();
      await room.collection('stories').upsert({
        id: newStoryId,
        title: `New Story by ${currentUser.username} - ${new Date().toLocaleDateString()}`,
        status: 'active',
        created_by_user_id: currentUser.id,
        last_updated_by_user_id: currentUser.id,
      });
      await room.updateRoomState({ activeStoryId: newStoryId, activeStoryPages: {} });
      setViewMode('story');
    } catch (error) {
      console.error("Error starting new story:", error);
      alert(`Failed to start new story: ${error.message}`);
    } finally {
      setIsLoadingGlobal(false);
    }
  };

  const handleViewStory = (story) => {
    setSelectedStoryForView(story);
    setViewMode('finishedStoryView');
  };
  
  const handleContinueStory = async (storyToContinue) => {
    if (!currentUser) {
        alert("User not loaded yet.");
        return;
    }
    setIsLoadingGlobal(true);
    try {
        // Fetch all pages for this story
        const pages = await room.collection('story_pages').filter({ story_id: storyToContinue.id }).getList();
        const pagesObject = pages.reduce((obj, page) => {
            obj[page.id] = page;
            return obj;
        }, {});

        // Update story status to active in DB
        await room.collection('stories').upsert({
            id: storyToContinue.id,
            status: 'active',
            last_updated_by_user_id: currentUser.id,
        });

        // Update roomState
        await room.updateRoomState({ activeStoryId: storyToContinue.id, activeStoryPages: pagesObject });
        setViewMode('story');

    } catch (error) {
        console.error("Error continuing story:", error);
        alert(`Failed to continue story: ${error.message}`);
    } finally {
        setIsLoadingGlobal(false);
    }
  };


  if (storiesLoading) return <div className="spinner"></div>;

  return (
    <div className="container mx-auto p-4">
      <h2 className="text-3xl font-bold mb-6 text-center">Story Gallery</h2>
      <div className="mb-6 text-center">
        <button onClick={handleStartNewStory} className="button button-primary mr-2">
          Start New Story
        </button>
         <button onClick={() => activeStoryIdFromStore && setViewMode('story')} 
            className="button button-secondary"
            disabled={!activeStoryIdFromStore} 
        >
          Back to Active Story
        </button>
      </div>

      {finishedStories.length === 0 ? (
        <p className="text-center text-gray-500">No finished stories yet. Why not start one?</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {finishedStories.map(story => (
            <div key={story.id} className="gallery-item p-4 border rounded-lg shadow hover:shadow-md">
              <h3 className="text-xl font-semibold mb-2">{story.title || 'Untitled Story'}</h3>
              <p className="text-sm text-gray-600 mb-1">Created: {new Date(story.created_at).toLocaleDateString()}</p>
              {/* Could show author if created_by_user_id is resolved to a name */}
              <div className="mt-3">
                <button onClick={() => handleViewStory(story)} className="button button-secondary text-sm mr-2">Read Story</button>
                <button onClick={() => handleContinueStory(story)} className="button button-primary text-sm">Continue This Story</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FinishedStoryViewer() {
  const { selectedStoryForView, setViewMode } = useUIStore();
  const { data: pagesData, loading: pagesLoading } = useQuery(
    selectedStoryForView ? room.collection('story_pages').filter({ story_id: selectedStoryForView.id }) : null
  );
  const [currentPageIndex, setCurrentPageIndex] = useState(0);

  const sortedPages = useMemo(() => {
    if (!pagesData) return [];
    // Assuming pagesData is already an array from useQuery if not null
    return [...pagesData].sort((a, b) => a.page_number - b.page_number);
  }, [pagesData]);

  if (!selectedStoryForView) {
    return <div className="text-center p-5">No story selected. <button onClick={() => setViewMode('gallery')} className="text-blue-500 hover:underline">Go to Gallery</button></div>;
  }
  if (pagesLoading) return <div className="spinner"></div>;

  return (
    <div className="container mx-auto p-4">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-3xl font-bold">{selectedStoryForView.title || 'Finished Story'}</h2>
        <button onClick={() => setViewMode('gallery')} className="button button-secondary">Back to Gallery</button>
      </div>

      {sortedPages.length > 0 ? (
        <>
          <PageViewer page={sortedPages[currentPageIndex]} />
          <div className="flex justify-between items-center my-4">
            <button
              onClick={() => setCurrentPageIndex(prev => Math.max(0, prev - 1))}
              disabled={currentPageIndex === 0}
              className="button button-primary"
            >
              Previous
            </button>
            <span className="text-gray-700">Page {currentPageIndex + 1} of {sortedPages.length}</span>
            <button
              onClick={() => setCurrentPageIndex(prev => Math.min(sortedPages.length - 1, prev + 1))}
              disabled={currentPageIndex === sortedPages.length - 1}
              className="button button-primary"
            >
              Next
            </button>
          </div>
        </>
      ) : (
        <p className="text-center text-gray-500">This story has no pages.</p>
      )}
    </div>
  );
}


function App() {
  const { viewMode, setViewMode, isLoadingGlobal } = useUIStore();
  const [activeStoryIdFromRoom, setActiveStoryIdFromRoom] = useState(null);
  const [activeStoryPagesFromRoom, setActiveStoryPagesFromRoom] = useState({});

  useEffect(() => {
    let unsubscribeRoomState = () => {}; // Ensure it's always a function

    const initApp = async () => {
      try {
        await room.initialize();
      
        // Initial state sync from room to local React state and Zustand store
        const initialActiveId = room.roomState?.activeStoryId || null;
        const initialActivePages = room.roomState?.activeStoryPages || {};
        
        setActiveStoryIdFromRoom(initialActiveId); // For StoryWorkspace prop
        setActiveStoryPagesFromRoom(initialActivePages); // For StoryWorkspace prop
        useUIStore.setState({ activeStoryIdFromRoom: initialActiveId }); // For Gallery and other potential consumers
        
        // Determine initial view mode
        if (initialActiveId) {
          setViewMode('story');
        } else {
          setViewMode('gallery');
        }

        // Single subscription to room state changes
        unsubscribeRoomState = room.subscribeRoomState((newState) => {
          const newActiveId = newState?.activeStoryId || null;
          const newActivePages = newState?.activeStoryPages || {};

          // Update local React state (for StoryWorkspace)
          setActiveStoryIdFromRoom(newActiveId);
          setActiveStoryPagesFromRoom(newActivePages);

          // Update Zustand store (for Gallery etc.)
          useUIStore.setState({ activeStoryIdFromRoom: newActiveId });
          
          // View mode logic based on story status
          const currentViewMode = useUIStore.getState().viewMode; // Get current viewMode
          if (!newActiveId && currentViewMode === 'story') {
              // If active story ends (becomes null) AND user is currently in 'story' view
              setViewMode('gallery');
          }
        });
      } catch (error) {
        console.error("Error during app initialization:", error);
        // Potentially set an error state in UIStore to show a global error message
        setViewMode('gallery'); // Fallback view
      }
    };

    initApp();

    return () => {
      unsubscribeRoomState(); // Cleanup subscription on component unmount
    };
  }, [setViewMode]); // setViewMode is from Zustand and is stable. Effect runs once on mount.
  
  // The useEffect that previously synced local activeStoryIdFromRoom to Zustand is no longer needed
  // as Zustand is updated directly in the room.subscribeRoomState callback.

  if (viewMode === 'loading' || isLoadingGlobal) {
    return (
      <div className="min-h-screen flex flex-col justify-center items-center">
        <div className="spinner"></div>
        <p className="text-xl mt-4 text-gray-600">Loading Storyteller...</p>
      </div>
    );
  }

  return (
    <div className="app-container">
      {viewMode === 'story' && <StoryWorkspace activeStoryId={activeStoryIdFromRoom} activeStoryPages={activeStoryPagesFromRoom} />}
      {viewMode === 'gallery' && <StoryGallery />}
      {viewMode === 'finishedStoryView' && <FinishedStoryViewer />}
    </div>
  );
}

const root = createRoot(document.getElementById('root'));
root.render(<App />);