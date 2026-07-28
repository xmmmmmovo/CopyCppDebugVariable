cmake_minimum_required(VERSION 3.20)

project(debug_variable_demo LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_executable(debug_variable_demo main.cpp)

target_compile_options(debug_variable_demo PRIVATE
    $<$<CXX_COMPILER_ID:GNU,Clang>:-Wall -Wextra -Wpedantic -O0 -g>
    $<$<CXX_COMPILER_ID:MSVC>:/W4 /Od>
)
